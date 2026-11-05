// dsh-codewiki — 客户端半侧（浏览器）v0.4.1
// 两个挂载点：
// 1. 「插件」页 `plugins.item`（id = codewiki，与 profile patch 条目一致）——设置表单；
// 2. 侧边栏面板 `main` + `sidebar.panellist`（参照 dsh-hindsight-on-demand）——编译任务进度与取消，
//    数据来自宿主半侧 webServer 端点 GET /api/codewiki/jobs、POST /api/codewiki/control（仅回环）。
// 设置读写经 configForms（宿主半侧 Config 服务命名空间 'codewiki'）；
// id 必须等于 package.json 的 name（client-modules 按 nearestPackage 的 name 校验注册者）；
// 词典值必须是字符串——词典值若为函数，t() 会回退返回键名。

window.__ModuleLoader__.load({
  id: '@local/dsh-codewiki',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Switch, Button, Input, Tag } = primitives

    const NS = 'codewiki' // profile patch 条目 id = 设置命名空间
    const KEY = 'codewiki' // 面板 key；sidebar.panellist 的 id 必须与它一致
    const JOBS_PATH = '/api/codewiki/jobs'
    const CONTROL_PATH = '/api/codewiki/control'
    const PANEL_ORDER = 52 // 排在 dsh-hindsight-on-demand（50）之后
    const POLL_MS = 2000
    const REPOS_PATH = '/api/codewiki/repos'
    const SESSIONS_PATH = '/api/codewiki/sessions'
    const SESSIONS_ITEM_PATH = '/api/codewiki/sessions/item'
    const MODELS_PATH = '/api/codewiki/models'
    const EFFORTS_PATH = '/api/codewiki/model-efforts'
    // 目录未声明 efforts 的模型（如 trae/mimo-v2.6-flash）在设置页展示的通用思考档位；
    // 选了模型不支持的值由 llmChat 兜底剥档重试，不会失败
    const GENERIC_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
    const REPOS_POLL_MS = 10000
    // queued 单列在最前：单项目串行时后提交的项目在此等待，阶段条第 0 个点亮表示排队。
    // 后面五步就是编译真实发生的事，一步不多：准备（探测环境+解析代码图+聚类）→ 写作 →
    // 校验 → 索引 → 提交。旧值 crosscut（横切）随单轮写作通道退役，原生通道
    // （唯一通道）从不经过它。
    // 「校对」不再单列一步：它是质量门死链检查的修复动作（检测→改正文→复检），与质量门
    // 本身是一件事的两半，分两格只会让人以为有两道重复检查。细分名称仍在活动流里可见
    // （NATIVE_STAGE_KEYS.proofread）。
    const ACTIVE_STAGES = ['queued', 'prepare', 'articles', 'validate', 'index', 'commit']
    // 每个阶段一个固定色相，用来在同一条进度条里区分「时间花在哪一步」。
    // 色相挑的是彼此相距 40° 上下、且在中低饱和下仍能分辨的几支：青→蓝→紫→琥珀→绿。
    // 明度与饱和度写在 CSS（58% / 52%），两套主题下都不用改。
    const STAGE_HUE = { queued: 210, prepare: 196, articles: 262, validate: 32, index: 152, commit: 220 }
    // 历史任务里还留着已退役的阶段名：不映射的话 indexOf 得 -1，步骤条在失败/取消时
    // 会整条熄灭、不标红，用户看不出卡在哪一步。review 在 0.17.41 并进 validate。
    const LEGACY_STAGE = { plan: 'prepare', crosscut: 'articles', review: 'validate' }
    const stageOf = (job) => LEGACY_STAGE[job?.stage] ?? job?.stage

    const zh = () => ({
      title: 'CodeWiki',
      summary: '随仓库的代码 wiki（<repo>/.codewiki/）：全批量流水线编译（零子代理），侧边栏面板可看进度。',
      intro: '维护各仓库 .codewiki/ 目录下的活 wiki（随仓库提交共享）。此处设置经 configForms 热生效，无需重启。',
      secRun: '运行',
      enabled: '启用插件',
      enabledHint: '停用后 cw 与 codewiki_generate 直接报错。',
      updateReminder: 'wiki 维护提醒',
      updateReminderHint: '改完代码后提醒更新 wiki（仓库根需有 CodeWiki.md）。',
      autoCommit: '自动提交编译产物',
      autoCommitHint: '由插件在主题分支提交并合并回原分支，只动 .codewiki/ 与 CodeWiki.md。',
      workspaceOnly: '只显示工作区任务',
      workspaceOnlyHint: '任务页只显示已添加工作区里的任务。',
      maxConcurrency: '默认档并发上限',
      maxConcurrencyHint: '默认档请求并发 1–8。',
      moduleConcurrency: '模块生成并行度',
      moduleConcurrencyHint: '同层模块并行写文档；留空或 0 跟随默认档，1 = 严格串行。',
      bigConcurrency: '大档并发上限',
      bigConcurrencyHint: '大档并发 1–8；留空跟随默认档。',
      serialProjects: '单项目串行',
      serialProjectsHint: '开启时只推进一个仓库；关闭后按并行上限推进。',
      parallelProjects: '并行项目上限',
      parallelProjectsHint: '同时推进的仓库数；需关闭单项目串行。',
      queueWaitLabel: '排队',
      runTimeLabel: '执行',
      queueAheadLabel: '在等',
      sessBtn: '会话',
      sessTitle: '编译会话（LLM 请求记录 · 保留 24h）',
      sessEmpty: '暂无会话记录（编译请求发起后出现）',
      sessNoCwd: '未关联仓库',
      sessGroupCount: '{n} 条请求',
      sessRunning: '进行中',
      sessActiveTitle: '进行中的任务',
      sessActiveNoRequest: '尚未发出请求（正在做准备/收尾）',
      sessActiveRequests: '已发 {n} 个请求',
      sessActiveStage: '阶段',
      sessActiveWritten: '已写 {n} 篇',
      sessPrompt: '输入 prompt',
      sessOutput: '模型输出',
      sessBack: '← 返回列表',
      tabSessions: '会话',
      sessGlobalTitle: '编译会话 · 全部任务（保留 24h）',
      sessGlobalHint: '跨任务列出并发池的每一次 LLM 请求：正在跑的实时刷新，点开看 prompt 与模型输出。',
      sessJob: '任务',
      secCompile: '编译模型',
      secCompileHint: '写文章与校对共用这一个模型，全部在插件内完成。',
      batchProvider: '模型提供商',
      batchProviderHint: '模型设置里已注册的提供商；凭证由宿主按它解析。',
      batchProviderMissing: '目录不可用，请手填 provider id',
      batchModel: '编译模型',
      batchModelHint: '该提供商下的模型 id，目录外的可手填。',
      batchModelManual: '手填模型 id…',
      catalogLoading: '正在读取模型目录…',
      catalogUnavailable: '模型目录不可用（{error}）——可手填提供商与模型 id。',
      catalogEmptyModels: '该提供商没有可枚举的模型，请手填模型 id。',
      batchReasoningEffort: '思考程度',
      batchReasoningEffortHint: '取自模型目录声明的档位；留空用模型默认。',
      batchReasoningEffortModel: '模型默认',
      batchReasoningEffortLoading: '正在读取该模型的思考档位…',
      batchReasoningEffortNone: '该模型未声明可选思考档位，只能用默认档。',
      batchReasoningEffortGeneric: '该模型目录未声明可选思考档位，以下为通用档位供手动指定；若模型不支持所选值，请求会自动回落模型默认档（不会失败）。',
      batchReasoningEffortError: '读取思考档位失败（{error}）——先用模型默认档。',
      secBig: '大档模型（超长输入）',
      secBigHint: '超过普通档单请求预算（110k）的模块改由这里一次写完。只对 Node 兼容通道生效（关闭「使用原生引擎」时）；原生通道的输入预算由引擎按模块切分，不经这一档。',
      bigEnabled: '启用大档模型（超长输入）',
      bigEnabledHint: '关闭后超预算请求不再换模型；下方配置保留。',
      requestLimit: '单模块请求上限',
      requestLimitHint: '单模块请求次数 1–1000；太小会让复杂模块中断成部分完成。',
      invalidRequestLimit: '单模块请求上限需在 1–1000 之间',
      bigProvider: '大档提供商',
      bigProviderOff: '（未启用大档）',
      bigProviderHint: '仅在启用大档时生效；凭证同样由宿主解析。',
      bigModel: '大档模型',
      bigModelHint: '建议选长上下文的模型。',
      bigReasoningEffort: '大档思考程度',
      bigReasoningEffortHint: '取自模型目录；留空用模型默认。',
      bigTokenBudget: '大档输入预算（token）',
      bigTokenBudgetHint: '须大于 110000，且不超过模型上下文扣掉输出后的余量。',
      bigDisabled: '大档通道已关闭（提供商留空）——超大输入将退回会话通道兜底。',
      articleLanguage: '文章语言',
      articleLanguageHint: '留空则跟随当前会话语言。',
      binaryPath: 'cw 可执行路径',
      binaryPathHint: '留空优先用 PATH 里的 cw，其次插件自带 bin/cw.exe。',
      secScale: '并发与语言',
      secNative: '原生引擎',
      secNativeHint: '关闭后退回内置 Node 流水线（兼容通道，不再加新能力）。',
      nativeEngine: '使用原生引擎',
      nativeEngineHint: '需要本机 Python 3.10+；环境不闭合会明确失败，不会悄悄换通道。',
      nativeEnginePython: 'Python 解释器',
      nativeEnginePythonHint: '留空依次用 DSH_CODEWIKI_PYTHON、PATH 里的 python。',
      nativeEngineEntry: '引擎入口脚本',
      nativeEngineEntryHint: '留空用插件自带的 entry.py。',
      nativeEngineTimeoutMs: '单次编译超时（毫秒）',
      nativeEngineTimeoutMsHint: '0 = 默认 180 分钟；超时按 partial 保留已写文章。',
      secIncremental: '增量策略（原生通道）',
      secIncrementalHint: '只在增量轮生效（scope=auto/stale 且已有编译基线）。留空一律用上游默认值，改错只会让增量更保守或更激进，不会写坏文章。',
      updateRung: '增量档位',
      updateRungDefault: '上游默认（3）',
      updateRungHint: '留空 = 3（组件级增量，全部能力）。3b = 同 3 但依赖跟两跳，影响面更大；2 = 只重写受影响的叶子页、不原地打补丁；1 = 纯规则失效，不开路由/重聚类/依赖扩散/陈旧扫描（最保守也最慢）；0 = 放弃组件级增量，每轮都按文件失效重写全部文章。',
      updateTauNb: 'tau_nb',
      updateTauNbHint: '0–1，路由判据：一个叶子里聚集多少比例的新增组件邻居才把改动路由过去。留空 = 0.5。',
      updateTauGrow: 'tau_grow',
      updateTauGrowHint: '0–1：新增组件占多少比例触发整体重聚类。留空 = 0.33。',
      updateTauFull: 'tau_full',
      updateTauFullHint: '0–1：活跃叶子占全部叶子超过此比例就整仓重写。留空 = 0.5；调大更倾向增量（快、可能漏改），调小更倾向重写（准、慢）。',
      updateTauTree: 'tau_tree',
      updateTauTreeHint: '0–1：新建+删除+重聚类的叶子占比超过此值就整仓重写。留空 = 0.3。',
      updateTauDefault: '默认',
      autoSaveIdle: '改动会自动保存',
      autoSaving: '保存中…',
      autoSaved: '已保存',
      autoSaveFailed: '保存失败，稍后会重试',
      autoSaveRetry: '立即重试',
      autoSaveHint: '改动停手 0.5 秒后自动保存，无需手动提交。',
      readonlyHint: '当前配置只读，改动不会落盘。',
      overviewClean: '干净',
      overviewStale: '有变更',
      overviewPending: '待确认',
      overviewBusy: '编译中',
      overviewTotal: '仓库',
      loadingLabel: '加载中…',
      conflict: '保存冲突：设置已被他处修改，请重试。',
      invalidConcurrency: '并发上限须为 1–8 的整数。',
      panelTitle: '编译任务',
      panelEmpty: '暂无编译任务——在会话里运行 codewiki_generate 开始编译。',
      stageQueued: '排队中',
      stagePrepare: '准备中',
      stageArticles: '写文章中',
      stageReview: '校对中',
      stageValidate: '校验中',
      stageIndex: '建索引中',
      stageCommit: '提交产物中',
      stageDone: '已完成',
      stagePartial: '部分完成',
      stageFailed: '失败',
      stageCancelled: '已取消',
      // 原生引擎（阶段 4）八段契约的真实阶段名：面板阶段条仍是粗粒度六步，
      // 引擎自报的阶段另显示一行——两者不是一回事，混着显示会让人以为步骤条错了。
      nativeStageLabel: '引擎阶段',
      channelNative: '原生引擎',
      nativeEnv: '探测环境',
      nativeGraph: '解析代码图',
      nativeCluster: '聚类模块',
      nativeValidate: '产物校验',
      nativeProofread: '语义校对',
      nativeBaseline: '推进基线',
      gateLabel: '质量门',
      applyLabel: '落地',
      stepQueued: '排队',
      kindFull: '全量',
      kindStale: '增量',
      kindResume: '续查',
      writtenLabel: '已写',
      failedLabel: '失败',
      unitArticle: '篇',
      cancelJob: '取消',
      cancelRequestedLabel: '取消中…',
      settings: '设置',
      elapsedLabel: '已用时',
      historyLabel: '历史任务',
      changedLabel: '变更文件',
      autoCommitOk: '产物已自动提交',
      autoCommitNone: '产物无改动，未提交',
      autoCommitPending: '产物未自动提交',
      wikiAt: 'wiki：',
      tabOverview: '总览',
      tabTasks: '任务',
      tabSettings: '设置',
      reposEmpty: '还没有已编译的仓库——在会话里运行 codewiki_generate 开始编译。',
      stateMissing: '未初始化',
      stateUncompiled: '未编译',
      stateClean: '最新',
      stateStale: '有变更',
      stateError: '出错',
      excludedTag: '已排除',
      excludeRepo: '排除',
      unexcludeRepo: '取消排除',
      autoTag: '自动',
      schedTitle: '自动更新调度',
      schedOn: '开',
      schedOff: '关',
      schedEvery: '扫描间隔',
      schedLast: '上次扫描',
      schedScanning: '正在扫描…',
      schedNever: '从未',
      schedMinutes: '分钟',
      compileNow: '更新',
      compileUpToDate: '已是最新',
      batchLabel: '批次',
      secSchedule: '调度与排除',
      autoUpdateLabel: '自动更新',
      autoUpdateHint: '定时扫描已编译过的仓库，检测到变更自动增量编译。',
      autoUpdateMinLabel: '扫描间隔（分钟）',
      autoUpdateMinHint: '最小 5 分钟；只提交有变更的仓库。',
      excludePathsLabel: '排除清单',
      excludePathsHint: '不编译的目录（含子目录）；换行、分号或逗号分隔。',
      stepPrepare: '准备',
      stepArticles: '文章',
      stepReview: '校对',
      stepValidate: '校验',
      stepIndex: '索引',
      stepCommit: '提交',
      perMin: '篇/分',
      etaLabel: '剩余',
      batchRunLabel: '执行中',
      usageIn: '输入',
      usageOut: '输出',
      reqLabel: '请求',
      batchChannel: '批量',
      realtimeChannel: '实时',
      overTierLabel: '个超单请求预算（按大档装填）',
      activityLabel: '活动流',
      taskListLabel: '逐篇',
      legendHint: '每段一个颜色代表一个阶段，段宽是这一步在总进度里占多少；当前阶段加粗，失败段标红。',
      legendHintDone: '每段一个颜色代表一个阶段，段宽是该阶段真实耗时——一眼看出时间花在哪一步。',
      emptyReposTitle: '还没有可编译的仓库',
      emptyTasksTitle: '还没有编译记录',
      emptySessionsTitle: '还没有模型请求',
      loadingTitle: '正在读取',
      activityHint: '最新一条已在上方常显，这里展开的是更早的条目。',
      legendState_done: '已完成',
      legendState_running: '进行中',
      legendState_failed: '失败',
      legendState_todo: '未开始',
      engineLogLabel: '引擎日志',
      engineLogFileLabel: '完整日志',
      lastCompile: '上次编译',
      nextScan: '下次扫描',
      scannedLabel: '扫描',
      submittedLabel: '提交',
      skippedLabel: '工作区外跳过',
      pendingLabel: '待确认',
      needConfirmTag: '待确认',
      confirmCompile: '确认编译',
      confirmHint: '这个仓库还没有 wiki。自动调度不会替你做这个决定——确认后才会开始首次编译；不想要就点排除，之后不再扫到它。',
      totalTimeLabel: '总耗时',
      copyPath: '复制路径',
      copiedLabel: '已复制',
      runningCount: '个进行中',
      runningLabel: '进行中',
      trendHint: '最近若干次采样的总进度',
      poolHint: '进行中任务的聚合进度',
      poolSlowest: '最慢',
      poolQueued: '排队',
      poolAllQueued: '{n} 个排队中',
      agoSuffix: '前',
    })
    const en = () => ({
      title: 'CodeWiki',
      summary: 'Repo-local code wiki (<repo>/.codewiki/): all-batch pipeline (zero subagents); track progress in the sidebar panel.',
      intro: 'Maintains a living wiki inside each repository at .codewiki/ (committed and shared with the repo). Settings here apply hot via configForms — no restart needed.',
      secRun: 'Runtime',
      enabled: 'Enable plugin',
      enabledHint: 'When off, cw and codewiki_generate error immediately.',
      updateReminder: 'Wiki update reminder',
      updateReminderHint: 'Reminds the session to update the wiki after code changes (only when the repo root has CodeWiki.md).',
      autoCommit: 'Auto-commit compiled wiki',
      autoCommitHint: 'The plugin commits the artifacts on a topic branch and merges them back, touching only .codewiki/ and CodeWiki.md. Falls back to an "artifacts pending" reminder when a branch workflow or the commit is impossible.',
      workspaceOnly: 'Workspace tasks only',
      workspaceOnlyHint: 'The jobs tab shows only tasks belonging to added dsh workspaces.',
      maxConcurrency: 'Default-tier concurrency',
      maxConcurrencyHint: 'In-flight requests for the default tier (batchModel), 1–8.',
      moduleConcurrency: 'Module parallelism',
      moduleConcurrencyHint: 'Modules on the same layer write concurrently; parents still wait for every child. Empty or 0 follows the default-tier concurrency; 1 is strictly sequential.',
      bigConcurrency: 'Big-tier concurrency',
      bigConcurrencyHint: 'In-flight requests for the big tier (bigModel), 1–8; empty follows the default tier.',
      serialProjects: 'One project at a time',
      serialProjectsHint: 'Only one repository compiles at a time; later submissions queue. Turn off to compile several repos in parallel.',
      parallelProjects: 'Parallel repo limit',
      parallelProjectsHint: 'How many repos compile simultaneously; effective when "One project at a time" is off.',
      queueWaitLabel: 'queued',
      runTimeLabel: 'running',
      queueAheadLabel: 'waiting for',
      sessBtn: 'Sessions',
      sessTitle: 'Compile sessions (LLM request log · kept 24h)',
      sessEmpty: 'No session records yet (they appear once compile requests start).',
      sessNoCwd: 'No repo',
      sessGroupCount: '{n} requests',
      sessRunning: 'in flight',
      sessActiveTitle: 'Jobs in progress',
      sessActiveNoRequest: 'No request yet (preparing or wrapping up)',
      sessActiveRequests: '{n} requests sent',
      sessActiveStage: 'stage',
      sessActiveWritten: '{n} articles written',
      sessPrompt: 'Input prompt',
      sessOutput: 'Model output',
      sessBack: '← Back to list',
      tabSessions: 'Sessions',
      sessGlobalTitle: 'Compile sessions · all jobs (kept 24h)',
      sessGlobalHint: 'Every LLM request of the concurrency pool across all jobs: running ones refresh live; open one for its prompt and model output.',
      sessJob: 'job',
      secCompile: 'Compile model',
      secCompileHint: 'Articles and proofreading share this model; all inside the plugin.',
      batchProvider: 'Model provider',
      batchProviderHint: 'A provider from model settings; the host resolves credentials.',
      batchProviderMissing: 'Catalog unavailable — type the provider id',
      batchModel: 'Compile model',
      batchModelHint: 'Model id under it; catalog misses can be typed in.',
      batchModelManual: 'Type a model id…',
      catalogLoading: 'Reading the model catalog…',
      catalogUnavailable: 'Model catalog unavailable ({error}) — type the provider and model id instead.',
      catalogEmptyModels: 'This provider exposes no enumerable models; type the model id.',
      batchReasoningEffort: 'Reasoning effort',
      batchReasoningEffortHint: 'Declared in the model catalog. Empty = model default.',
      batchReasoningEffortModel: 'Model default',
      batchReasoningEffortLoading: 'Reading this model\'s reasoning efforts…',
      batchReasoningEffortNone: 'This model declares no selectable efforts; only the default applies.',
      batchReasoningEffortGeneric: 'The model catalog declares no efforts for this model; the generic levels below can be set manually. If the model rejects the chosen level, the request automatically falls back to the model default (it will not fail).',
      batchReasoningEffortError: 'Could not read reasoning efforts ({error}) — keeping the model default.',
      secBig: 'Large-input model',
      secBigHint: 'Modules over the normal 110k request budget use this model. Only the Node compatibility channel (native engine off) uses this tier; the native channel splits input per module inside the engine.',
      bigEnabled: 'Enable large-tier model (very long input)',
      bigEnabledHint: 'When off, requests above the normal budget stay at the normal tier. Configured values are kept for re-enabling.',
      requestLimit: 'Per-module request limit',
      requestLimitHint: 'Requests allowed while writing one module, 1-1000. Too low and complex modules stop as partial.',
      invalidRequestLimit: 'Per-module request limit must be between 1 and 1000',
      bigProvider: 'Large-tier provider',
      bigProviderOff: '(large tier off)',
      bigProviderHint: 'Only used while the large tier is on.',
      bigModel: 'Large-tier model',
      bigModelHint: 'Model id under that provider.',
      bigReasoningEffort: 'Large-tier reasoning effort',
      bigReasoningEffortHint: 'From the model catalog. Empty = model default.',
      bigTokenBudget: 'Large-tier input budget (tokens)',
      bigTokenBudgetHint: 'Must exceed the normal 110000 and fit in the model context window after reserving output.',
      bigDisabled: 'Large tier off (empty provider) — oversized input falls back to the session channel.',
      articleLanguage: 'Article language',
      articleLanguageHint: 'Empty follows the current session language.',
      binaryPath: 'cw binary path',
      binaryPathHint: 'Empty = cw on PATH first, bundled bin/cw.exe as fallback.',
      secScale: 'Concurrency & language',
      secNative: 'Native engine',
      secNativeHint: 'Off falls back to the built-in Node pipeline (compatibility channel, no new features).',
      nativeEngine: 'Use the native engine',
      nativeEngineHint: 'Needs local Python 3.10+ with a closed dependency environment; an unclosed environment fails as engine-deps instead of silently switching channels.',
      nativeEnginePython: 'Python interpreter',
      nativeEnginePythonHint: 'Empty tries DSH_CODEWIKI_PYTHON, then python on PATH.',
      nativeEngineEntry: 'Engine entry script',
      nativeEngineEntryHint: 'Empty uses the bundled lib/engine/python/entry.py.',
      nativeEngineTimeoutMs: 'Per-run timeout (ms)',
      nativeEngineTimeoutMsHint: '0 = the default 180 minutes; a timeout salvages written articles as partial.',
      secIncremental: 'Incremental strategy (native channel)',
      secIncrementalHint: 'Applies to incremental rounds only (scope=auto/stale with an existing baseline). Empty values use upstream defaults; getting them wrong only makes updates more conservative or more aggressive, it never corrupts articles.',
      updateRung: 'Incremental rung',
      updateRungDefault: 'Upstream default (3)',
      updateRungHint: 'Empty = 3 (component-level update, all capabilities). 3b = rung 3 with 2 dependency hops; 2 = rewrite affected leaf pages only, no in-place patching; 1 = rule-based invalidation only, no routing/re-clustering/dependents/stale scan (most conservative, slowest); 0 = drop component-level update, rewrite every page by file invalidation each round.',
      updateTauNb: 'tau_nb',
      updateTauNbHint: '0-1, routing threshold: the share of new-component neighbours clustered in one leaf that routes the diff there. Empty = 0.5.',
      updateTauGrow: 'tau_grow',
      updateTauGrowHint: '0-1: share of new components that triggers re-clustering. Empty = 0.33.',
      updateTauFull: 'tau_full',
      updateTauFullHint: '0-1: rewrite the whole repo once active leaves exceed this share of all leaves. Empty = 0.5; higher favours incremental (faster, may miss edits), lower favours rewrite (accurate, slower).',
      updateTauTree: 'tau_tree',
      updateTauTreeHint: '0-1: rewrite the whole repo once created+deleted+re-clustered leaves exceed this share. Empty = 0.3.',
      updateTauDefault: 'default',
      autoSaveIdle: 'Changes save automatically',
      autoSaving: 'Saving…',
      autoSaved: 'Saved',
      autoSaveFailed: 'Save failed, will retry',
      autoSaveRetry: 'Retry now',
      autoSaveHint: 'Changes save automatically 0.5s after you stop editing.',
      readonlyHint: 'Configuration is read-only; changes will not be saved.',
      overviewClean: 'Clean',
      overviewStale: 'Changed',
      overviewPending: 'Needs confirm',
      overviewBusy: 'Compiling',
      overviewTotal: 'Repos',
      loadingLabel: 'Loading…',
      conflict: 'Save conflict: settings changed elsewhere, please retry.',
      invalidConcurrency: 'Concurrency cap must be an integer between 1 and 8.',
      panelTitle: 'Compilation jobs',
      panelEmpty: 'No compilation jobs yet — run codewiki_generate in a session to start one.',
      stageQueued: 'Queued',
      stagePrepare: 'Preparing',
      stageArticles: 'Writing articles',
      stageReview: 'Proofreading',
      stageValidate: 'Validating',
      stageIndex: 'Indexing',
      stageCommit: 'Committing',
      stepQueued: 'Queue',
      stageDone: 'Done',
      stagePartial: 'Partial',
      stageFailed: 'Failed',
      stageCancelled: 'Cancelled',
      nativeStageLabel: 'Engine stage',
      channelNative: 'Native engine',
      nativeEnv: 'Probing environment',
      nativeGraph: 'Parsing code graph',
      nativeCluster: 'Clustering modules',
      nativeValidate: 'Validating output',
      nativeProofread: 'Proofreading content',
      nativeBaseline: 'Advancing baseline',
      gateLabel: 'Quality gate',
      applyLabel: 'Apply',
      kindFull: 'Full',
      kindStale: 'Stale',
      kindResume: 'Resume',
      writtenLabel: 'written',
      failedLabel: 'failed',
      unitArticle: 'articles',
      cancelJob: 'Cancel',
      cancelRequestedLabel: 'Cancelling…',
      settings: 'Settings',
      elapsedLabel: 'elapsed',
      historyLabel: 'History',
      changedLabel: 'changed files',
      autoCommitOk: 'artifacts auto-committed',
      autoCommitNone: 'no artifact changes, nothing committed',
      autoCommitPending: 'artifacts not committed',
      wikiAt: 'wiki: ',
      tabOverview: 'Overview',
      tabTasks: 'Jobs',
      tabSettings: 'Settings',
      reposEmpty: 'No compiled repos yet — run codewiki_generate in a session to start one.',
      stateMissing: 'No wiki',
      stateUncompiled: 'Uncompiled',
      stateClean: 'Up to date',
      stateStale: 'Changed',
      stateError: 'Error',
      excludedTag: 'Excluded',
      excludeRepo: 'Exclude',
      unexcludeRepo: 'Un-exclude',
      autoTag: 'Auto',
      schedTitle: 'Auto-update scheduler',
      schedOn: 'On',
      schedOff: 'Off',
      schedEvery: 'Interval',
      schedLast: 'Last scan',
      schedScanning: 'Scanning…',
      schedNever: 'never',
      schedMinutes: 'min',
      compileNow: 'Update',
      compileUpToDate: 'Up to date',
      batchLabel: 'Batch',
      secSchedule: 'Scheduler & exclusions',
      autoUpdateLabel: 'Auto update',
      autoUpdateHint: 'Periodically scans compiled workspaces and submits incremental recompiles when changes are detected (scope=auto).',
      autoUpdateMinLabel: 'Scan interval (minutes)',
      autoUpdateMinHint: 'Minimum 5. Each scan runs cw status per historical workspace and submits only changed ones.',
      excludePathsLabel: 'Excluded paths',
      excludePathsHint: 'Directories (subtree included) never compiled; newline / semicolon / comma separated absolute paths.',
      stepPrepare: 'Prep',
      stepArticles: 'Write',
      stepReview: 'Proof',
      stepValidate: 'Check',
      stepIndex: 'Index',
      stepCommit: 'Commit',
      perMin: 'articles/min',
      etaLabel: 'remaining',
      batchRunLabel: 'Running',
      usageIn: 'in',
      usageOut: 'out',
      reqLabel: 'requests',
      batchChannel: 'batch',
      realtimeChannel: 'realtime',
      overTierLabel: 'over the single-request budget (large tier)',
      activityLabel: 'Activity',
      taskListLabel: 'Per page',
      legendHint: 'Each colour is one stage; segment width is how much of the total progress it accounts for.',
      legendHintDone: 'Each colour is one stage; segment width is that stage real wall time — see at a glance where the time went.',
      emptyReposTitle: 'No repos to compile yet',
      emptyTasksTitle: 'Nothing compiled yet',
      emptySessionsTitle: 'No model requests yet',
      loadingTitle: 'Loading',
      activityHint: 'The latest entry is already shown above; this expands the earlier ones.',
      legendState_done: 'done',
      legendState_running: 'running',
      legendState_failed: 'failed',
      legendState_todo: 'pending',
      engineLogLabel: 'Engine log',
      engineLogFileLabel: 'Full log',
      lastCompile: 'last compile',
      nextScan: 'Next scan',
      scannedLabel: 'scanned',
      submittedLabel: 'submitted',
      skippedLabel: 'skipped (outside workspace)',
      pendingLabel: 'awaiting confirmation',
      needConfirmTag: 'needs OK',
      confirmCompile: 'Compile',
      confirmHint: 'This repo has no wiki yet. The scheduler will not decide that for you — the first compile starts only after you confirm. Not interested? Exclude it and it will no longer be scanned.',
      totalTimeLabel: 'total',
      copyPath: 'Copy path',
      copiedLabel: 'Copied',
      runningCount: 'running',
      runningLabel: 'Running',
      trendHint: 'Total progress over recent polls',
      poolHint: 'Aggregate progress across running jobs',
      poolSlowest: 'slowest',
      poolQueued: 'queued',
      poolAllQueued: '{n} queued',
      agoSuffix: 'ago',
    })

    const style = document.createElement('style')
    style.dataset.plugin = '@local/dsh-codewiki'
    style.textContent = [
      '[data-dscw-page] { display: flex; flex-direction: column; gap: 16px; max-width: 1280px; padding-bottom: 28px; color: var(--dsw-alias-label-primary); }',
      // 分类卡片：五个分组各成一张卡，横向按可用宽度自动排 1–3 列。
      // 原来是单列长表 + 132px 标签列，宽面板里右侧大半是空白；卡片化之后
      // 同样的字段占更少的纵向高度，分组边界也从「一条细线」变成实物边界。
      '[data-dscw-cards] { columns: 3; column-gap: 12px; }',
      '[data-dscw-cards] > [data-dscw-sec] { break-inside: avoid; break-inside: avoid-column; margin: 0 0 12px; }',
      // 窄面板退成两列 / 一列：多列布局在窄容器里会把卡片压到 300px 以下，
      // 长 placeholder 与整数输入框都会开始截断。
      '@media (max-width: 1020px) { [data-dscw-cards] { columns: 2; } }',
      '@media (max-width: 660px) { [data-dscw-cards] { columns: 1; } }',
      // 分组：一条标签 + 一行细线把它和下面的字段切开。之前五个分组之间只靠 24px 空白
      // 分隔，滚动时看不出「哪几行属于同一件事」；细线比再加一个描边盒子轻得多。
      '[data-dscw-sec] { display: flex; flex-direction: column; gap: 6px; padding: 11px 13px 13px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); box-sizing: border-box; }',
      '[data-dscw-head] { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }',
      '[data-dscw-head] h4 { margin: 0; font-size: 12.5px; font-weight: 600; line-height: 18px; letter-spacing: .01em; text-transform: none; }',
      '[data-dscw-hint] { font-size: 11px; line-height: 15.5px; color: var(--dsw-alias-label-tertiary); text-wrap: pretty; }',
      // 卡片内一列到底：标签一行、控件一行。卡片最窄 340px，再切 132px 标签列会把
      // 输入框压到 200px 以下，长 placeholder 直接被截掉。
      '[data-dscw-grid] { display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; }',
      '[data-dscw-grid] > label { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); margin-top: 7px; }',
      '[data-dscw-grid] > label:first-child { margin-top: 0; }',
      // 开关类字段：控件只有一行高，再按「标签一行 + 控件一行 + 说明三行」堆，
      // 卡片里就会连续出现一片只有右边有个小圆点的空白带。改成标签与开关同行。
      '[data-dscw-toggle] { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 7px; min-width: 0; }',
      '[data-dscw-toggle]:first-child { margin-top: 0; }',
      '[data-dscw-toggle] > label { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); min-width: 0; }',
      '[data-dscw-toggle] > * { flex: none; }',
      '[data-dscw-field] { display: flex; flex-direction: column; gap: 3px; min-width: 0; }',
      '[data-dscw-select] { width: 100%; font: inherit; font-size: 12px; line-height: 18px; padding: 6px 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); box-sizing: border-box; transition: border-color .14s ease; }',
      '[data-dscw-select]:hover { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, var(--dsw-alias-border-l2)); }',
      '[data-dscw-select]:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }',
      // 保存条钉在底部：设置页比一屏高，滚到一半想保存时不该再滚回去找按钮。
      // 自动保存状态行：粘底但不抢注意力——它报的是「已经处理好了」，
      // 所以用 tertiary 色的小字，只有出错/保存中才升级成色块 + 重试按钮。
      '[data-dscw-bar] { position: sticky; bottom: -1px; display: flex; align-items: center; gap: 7px; padding: 7px 10px; margin-top: 2px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l3); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 88%, transparent); backdrop-filter: blur(6px); font-size: 11.5px; line-height: 16px; }',
      '[data-dscw-bar]::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-border-l3); }',
      '[data-dscw-bar][data-state="saving"]::before { background: var(--dsw-alias-brand-primary); animation: dscw-pulse 1.2s ease-in-out infinite; }',
      '[data-dscw-bar][data-state="saved"]::before { background: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)); }',
      '[data-dscw-bar][data-state="error"]::before { background: var(--dsw-alias-state-error-primary, var(--dsw-alias-warn, #c33)); }',
      '@media (prefers-reduced-motion: reduce) { [data-dscw-bar][data-state="saving"]::before { animation: none; } }',
      '[data-dscw-savestate] { color: var(--dsw-alias-label-tertiary); }',
      '[data-dscw-bar][data-state="saving"] [data-dscw-savestate] { color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-bar][data-state="saved"] [data-dscw-savestate] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-bar][data-state="error"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, var(--dsw-alias-warn, #c33)) 45%, var(--dsw-alias-border-l3)); }',
      '[data-dscw-bar][data-state="error"] [data-dscw-savestate] { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary)); }',
      '[data-dscw-notice] { font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-warn] { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)); font-size: 11.5px; line-height: 17px; }',
      // 侧边栏面板
      // 侧边栏面板：一层是「进行中」的活卡（总百分比 + 分阶段百分比），一层是历史。
      '[data-dscw-p-page] { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px 20px; font-size: 13px; color: var(--dsw-alias-label-primary); box-sizing: border-box; height: 100%; overflow-y: auto; }',
      '[data-dscw-p-page] * { box-sizing: border-box; }',
      '[data-dscw-p-head] { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
      '[data-dscw-p-head] h3 { margin: 0; font-size: 14px; font-weight: 500; line-height: 22px; letter-spacing: -0.01em; }',
      '[data-dscw-p-row] { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '[data-dscw-p-actions] { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }',
      '[data-dscw-p-stage] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-stage][data-state="done"] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-stage][data-state="failed"] { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-stage][data-state="cancelled"] { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-stage][data-state="clean"] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-stage][data-state="stale"] { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)); }',
      '[data-dscw-p-stage][data-state="missing"], [data-dscw-p-stage][data-state="uncompiled"] { color: var(--dsw-alias-label-tertiary); }',
      '[data-dscw-p-stage][data-running="true"] { animation: dscw-pulse 1.6s ease-in-out infinite; }',
      '[data-dscw-p-meta] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); word-break: break-all; }',
      '[data-dscw-p-subline] { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }',
      '[data-dscw-p-subline] > [data-dscw-p-note] { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; color: var(--dsw-alias-label-tertiary); }',
      '[data-dscw-p-cwd] { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }',
      // 空状态：一句灰字看起来像「没加载出来」。给一个标题 + 一句为什么是空的，
      // 读者才知道这是正常状态、不是坏了。
      '[data-dscw-p-empty] { display: flex; flex-direction: column; gap: 3px; padding: 18px 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }',
      '[data-dscw-p-empty] > strong { font-weight: 500; color: var(--dsw-alias-label-secondary); }',
      // 加载态画骨架而不是一个「…」：读者能据此判断「马上会有什么」和「大概占多高」，
      // 也不会在数据到达时整块跳一下。
      '[data-dscw-p-skel] { display: flex; flex-direction: column; gap: 8px; padding: 6px 0; }',
      '[data-dscw-p-skel] > i { display: block; height: 10px; border-radius: 4px; background: linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-border-l3) 70%, transparent) 0%, color-mix(in srgb, var(--dsw-alias-border-l3) 30%, transparent) 50%, color-mix(in srgb, var(--dsw-alias-border-l3) 70%, transparent) 100%); background-size: 200% 100%; animation: dscw-shimmer 1.4s linear infinite; }',
      '[data-dscw-p-skel] > i[data-w="100"] { width: 100%; }',
      '[data-dscw-p-skel] > i[data-w="72"] { width: 72%; }',
      '[data-dscw-p-skel] > i[data-w="46"] { width: 46%; }',
      '@keyframes dscw-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }',
      '@media (prefers-reduced-motion: reduce) { [data-dscw-p-skel] > i { animation: none; } }',
      '[data-dscw-p-history] { margin-top: 4px; }',
      // 可折叠行统一一个 ▸ 指示器。原生 marker 在不同字号下行高对不齐；而且
      // tasklist / repofold 设了 list-style: none 之后连三角都没了——读者无从判断
      // 「这行能点开」。用 ::before 画一个尺寸一致的三角，展开时旋转 90 度。
      '[data-dscw-p-history] > summary, [data-dscw-p-tasklist] > summary, [data-dscw-p-engine-log] > summary, [data-dscw-p-repofold] > summary { list-style: none; }',
      '[data-dscw-p-history] > summary::-webkit-details-marker, [data-dscw-p-tasklist] > summary::-webkit-details-marker, [data-dscw-p-engine-log] > summary::-webkit-details-marker, [data-dscw-p-repofold] > summary::-webkit-details-marker { display: none; }',
      '[data-dscw-p-history] > summary::before, [data-dscw-p-tasklist] > summary::before, [data-dscw-p-engine-log] > summary::before, [data-dscw-p-repofold] > summary::before { content: "\u25b8"; display: inline-block; margin-right: 6px; font-size: 8px; line-height: 1; color: var(--dsw-alias-label-tertiary); transition: transform .16s ease; }',
      '[data-dscw-p-history][open] > summary::before, [data-dscw-p-tasklist][open] > summary::before, [data-dscw-p-engine-log][open] > summary::before, [data-dscw-p-repofold][open] > summary::before { transform: rotate(90deg); }',
      '[data-dscw-p-history] > summary { cursor: pointer; user-select: none; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); margin-bottom: 8px; }',
      '[data-dscw-p-history] > summary:hover { color: var(--dsw-alias-label-primary); }',
      // 任务卡：左侧一条状态色轨代替整圈描边，进行中只加一层极淡的品牌色底。
      '[data-dscw-p-job] { position: relative; display: flex; flex-direction: column; gap: 7px; padding: 10px 12px 10px 16px; border-radius: 12px; border: 0.5px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1, transparent); transition: border-color .18s ease, background-color .18s ease; }',
      '[data-dscw-p-job]::before { content: ""; position: absolute; left: 6px; top: 11px; bottom: 11px; width: 2px; border-radius: 2px; background: var(--dsw-alias-border-l2); }',
      '[data-dscw-p-job][data-active="true"] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 36%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 5%, var(--dsw-alias-bg-layer-1, transparent)); }',
      '[data-dscw-p-job][data-active="true"]::before { background: var(--dsw-alias-brand-primary); }',
      '[data-dscw-p-job][data-tone="done"]::before { background: var(--dsw-alias-state-success-primary, var(--dsw-alias-border-l2)); }',
      '[data-dscw-p-job][data-tone="partial"]::before, [data-dscw-p-job][data-tone="cancelled"]::before { background: var(--dsw-alias-state-warning-primary, var(--dsw-alias-border-l2)); }',
      '[data-dscw-p-job][data-tone="failed"]::before { background: var(--dsw-alias-state-error-primary, var(--dsw-alias-border-l2)); }',
      // 进度一行放完：大数字 · 主进度条 · 趋势 · 当前阶段说明。分三行会白吃 60px 高度。
      '[data-dscw-p-progress] { display: flex; align-items: center; gap: 10px; }',
      '[data-dscw-p-pct] { display: flex; align-items: baseline; flex: none; font-size: 22px; line-height: 1; font-weight: 600; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }',
      '[data-dscw-p-pct] [data-unit] { font-size: 12px; font-weight: 500; letter-spacing: 0; color: var(--dsw-alias-label-tertiary); margin-left: 2px; }',
      '[data-dscw-p-pctmeta] { display: flex; flex: none; align-items: baseline; gap: 6px; margin-left: auto; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }',
      '[data-dscw-p-pctmeta] > span[data-faint] { color: var(--dsw-alias-label-tertiary); }',
      '[data-dscw-p-bar] { position: relative; flex: 1 1 auto; min-width: 40px; height: 5px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--dsw-alias-border-l3) 60%, transparent); }',
      '[data-dscw-p-barfill] { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width .45s cubic-bezier(.22, .61, .36, 1); }',
      '[data-dscw-p-bar][data-tone="done"] [data-dscw-p-barfill] { background: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)); }',
      '[data-dscw-p-bar][data-tone="failed"] [data-dscw-p-barfill] { background: var(--dsw-alias-state-error-primary, var(--dsw-alias-brand-primary)); }',
      '[data-dscw-p-bar][data-tone="partial"] [data-dscw-p-barfill], [data-dscw-p-bar][data-tone="cancelled"] [data-dscw-p-barfill] { background: var(--dsw-alias-state-warning-primary, var(--dsw-alias-brand-primary)); }',
      // 历史区按仓库折叠：同一仓库几十轮平铺会把别的仓库挤出视野。
      '[data-dscw-p-groups] { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }',
      '[data-dscw-p-repofold] { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 10px; overflow: hidden; }',
      '[data-dscw-p-repofold] > summary { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; font-size: 11.5px; color: var(--dsw-alias-label-secondary); list-style: none; }',
      '[data-dscw-p-repofold] > summary::-webkit-details-marker { display: none; }',
      '[data-dscw-p-repofold] > summary:hover { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 70%, transparent); }',
      '[data-dscw-p-repofold] > summary > [data-count] { margin-left: auto; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }',
      '[data-dscw-p-repofold] > [data-body] { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px 8px; }',
      '[data-dscw-p-trend] { color: var(--dsw-alias-brand-primary); opacity: .75; align-self: center; }',
      '[data-dscw-p-pool] { margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }',
      '[data-dscw-p-seclabel] { display: flex; align-items: center; gap: 6px; font-size: 11px; line-height: 16px; letter-spacing: 0.05em; color: var(--dsw-alias-label-tertiary); }',
      '[data-dscw-p-seclabel]::after { content: ""; flex: 1; height: 0.5px; background: var(--dsw-alias-border-l3); }',
      '[data-dscw-p-jobs] { display: flex; flex-direction: column; gap: 10px; }',
      // 设置区不再套一层描边盒子：每个分组已有自己的标签与细线，盒中盒会给同一页画出两级
      // 同等重量的边界，读起来像两个嵌套的表单。
      '[data-dscw-p-settings] { padding: 2px 0 0; }',
      // 标签条：四个等宽等分的格子，当前项用一条 2px 品牌色下划线标出来。
      // 药丸式的实心块会把「当前页」画成一个按钮，和旁边的操作按钮抢注意力；
      // 下划线是导航的惯用语法，读者不用想就知道自己在哪一格。
      '[data-dscw-p-tabs] { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }',
      '[data-dscw-p-tab] { position: relative; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 12px; line-height: 18px; padding: 7px 4px 9px; cursor: pointer; transition: color .16s ease; }',
      '[data-dscw-p-tab]:hover { color: var(--dsw-alias-label-primary); }',
      '[data-dscw-p-tab]:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; border-radius: 4px; }',
      '[data-dscw-p-tab]::after { content: ""; position: absolute; left: 12%; right: 12%; bottom: -0.5px; height: 2px; border-radius: 1px 1px 0 0; background: var(--dsw-alias-brand-primary); transform: scaleX(0); transform-origin: center; transition: transform .22s cubic-bezier(.22,.61,.36,1); }',
      '[data-dscw-p-tab][data-on="true"] { color: var(--dsw-alias-label-primary); font-weight: 500; }',
      '[data-dscw-p-tab][data-on="true"]::after { transform: scaleX(1); }',
      // 总览：调度信息是一块浅底摘要（它不算「对象」，不需要边框把它框成一个卡），
      // 仓库是一个列表——行之间用 0.5px 分隔线，而不是每个仓库各套一个圆角框。
      // 十几个仓库各带一个框时，视觉上得到十几个同等重量的盒子，反而看不出主次。
      // 总览统计条：五个数字格。这里刻意不画进度条或图表——仓库总数是个位数到十几，
      // 条形图会给出「量级」的错觉；数字 + 标签在等宽数字下逐列对齐，扫一眼就能比。
      '[data-dscw-p-stats] { display: grid; grid-template-columns: repeat(auto-fit, minmax(78px, 1fr)); gap: 6px; }',
      '[data-dscw-p-stat] { display: flex; flex-direction: column; gap: 1px; padding: 7px 9px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 70%, transparent); }',
      '[data-dscw-p-stat] b { font-size: 17px; line-height: 20px; font-weight: 600; letter-spacing: -.02em; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }',
      '[data-dscw-p-stat] span { font-size: 10.5px; line-height: 14px; color: var(--dsw-alias-label-tertiary); }',
      '[data-dscw-p-stat][data-tone="warn"] { background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)) 12%, transparent); }',
      '[data-dscw-p-stat][data-tone="warn"] b { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)); }',
      '[data-dscw-p-stat][data-tone="ok"] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)) 12%, transparent); }',
      '[data-dscw-p-stat][data-tone="ok"] b { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)); }',
      // 待办优先的清单：需要动手的两档（待确认 / 有变更）给一点左侧强调，
      // 免得排在列表顶部但和「干净」长得一样，读者还是要逐个读状态词。
      '[data-dscw-p-repo][data-rank="0"] { box-shadow: inset 2px 0 0 var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)); }',
      '[data-dscw-p-repo][data-rank="1"] { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent); }',
      '[data-dscw-p-repo][data-rank="4"] { box-shadow: inset 2px 0 0 var(--dsw-alias-state-error-primary, var(--dsw-alias-border-l3)); }',
      '[data-dscw-p-sched] { display: flex; flex-direction: column; gap: 3px; padding: 9px 11px; border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 80%, transparent); font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-p-sched] [data-dscw-p-row] { font-size: 12px; color: var(--dsw-alias-label-primary); }',
      '[data-dscw-p-repolist] { display: flex; flex-direction: column; }',
      '[data-dscw-p-repo] { display: flex; flex-direction: column; gap: 3px; padding: 9px 2px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }',
      '[data-dscw-p-repo]:last-child { border-bottom: 0; }',
      '[data-dscw-p-repo]:hover { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent); }',
      '[data-dscw-p-repo] [data-dscw-p-row] { gap: 6px; }',
      '[data-dscw-p-tasklist] > summary { cursor: pointer; user-select: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); list-style: none; }',
      '[data-dscw-p-tasklist] > summary::-webkit-details-marker { display: none; }',
      '[data-dscw-p-tasklist] > summary:hover { color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-p-tasklist] > [data-body] { display: flex; flex-direction: column; gap: 1px; max-height: 180px; overflow-y: auto; margin-top: 4px; padding-left: 8px; border-left: 2px solid var(--dsw-alias-border-l3); font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-p-task] { display: flex; gap: 6px; align-items: baseline; }',
      '[data-dscw-p-task] [data-mark] { flex: none; width: 12px; text-align: center; }',
      '[data-dscw-p-task][data-state="done"] [data-mark] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-task][data-state="failed"] [data-mark] { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-textarea] { width: 100%; min-height: 64px; resize: vertical; font: inherit; font-size: 12px; line-height: 18px; padding: 6px 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); box-sizing: border-box; }',
      // 吞吐徽标：方角，读数用等宽数字对齐
      // 分段带就是进度条本体（0.17.46）：段宽=该阶段占总时间的比例，段色=阶段身份。
      // 段色用固定色相而非主题色：五个阶段必须彼此可分辨，全用 brand-primary 就退化成一条纯色。
      // 明度锁在 52%，深浅两套主题下都能读；未跑完的部分用同色低透明度打底，所以
      // 「这段是什么」（色相）与「这段做到哪」（填充宽度）互不占用同一个通道。
      '[data-dscw-p-segbar] { display: flex; gap: 2px; flex: 1 1 auto; min-width: 40px; height: 5px; }',
      // 最小宽度 3px：真机上准备段常占 99%（06:54 对 790ms），不给小段保底宽度，
      // 「校验 24ms」这类阶段会缩成亚像素直接看不见——而它们恰恰是「这几步都不慢」的证据。
      '[data-dscw-p-seg] { position: relative; min-width: 3px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, hsl(var(--seg-hue) 58% 52%) 20%, transparent); }',
      '[data-dscw-p-seg]::after { content: ""; position: absolute; inset: 0 auto 0 0; width: var(--seg-done, 100%); background: hsl(var(--seg-hue) 58% 52%); transition: width .45s cubic-bezier(.22,.61,.36,1); }',
      '[data-dscw-p-seg][data-state="failed"]::after { background: var(--dsw-alias-state-error-primary, hsl(var(--seg-hue) 58% 52%)); }',
      '[data-dscw-p-seg][data-state="failed"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, hsl(var(--seg-hue) 58% 52%)) 20%, transparent); }',
      // 图例：与分段带同色，把颜色和阶段绑起来。终态读耗时，进行中读百分比。
      '[data-dscw-p-legend] { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 12px; font-size: 10.5px; line-height: 15px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }',
      '[data-dscw-p-legend] > span { display: inline-flex; align-items: center; gap: 4px; }',
      '[data-dscw-p-legend] [data-swatch] { flex: none; width: 7px; height: 7px; border-radius: 2px; background: hsl(var(--seg-hue) 58% 52%); }',
      '[data-dscw-p-legend] > span[data-state="todo"] [data-swatch] { opacity: .35; }',
      '[data-dscw-p-legend] > span[data-state="failed"] [data-swatch] { background: var(--dsw-alias-state-error-primary, hsl(var(--seg-hue) 58% 52%)); }',
      '[data-dscw-p-legend] > span[data-state="running"] { color: var(--dsw-alias-label-primary); font-weight: 600; }',
      '[data-dscw-p-badge] { display: inline-flex; align-items: center; gap: 5px; padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 10%, transparent); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }',
      '[data-dscw-p-badge][data-tone="live"] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, currentColor) 12%, transparent); }',
      '[data-dscw-p-badge] svg { display: block; }',
      '[data-dscw-p-usage] { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }',
      '[data-dscw-p-usage] [data-warn] { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)); }',
      '[data-dscw-p-error] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); word-break: break-all; }',
      '[data-dscw-p-activity] { margin-top: 2px; }',
      '[data-dscw-p-activity] summary { cursor: pointer; user-select: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }',
      '[data-dscw-p-activity] summary:hover, [data-dscw-p-engine-log] summary:hover { color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-p-activity] > [data-body] { display: flex; flex-direction: column; margin-top: 4px; max-height: 220px; overflow-y: auto; }',
      // 每条活动一行：状态点 | 阶段标签 | 正文。竖向连线用行自身的 ::before 画，
      // 这样最后一条不用单独去尾，靠 overflow 裁掉即可。
      '[data-dscw-p-actrow] { position: relative; display: flex; align-items: baseline; gap: 6px; padding: 3px 0 3px 14px; font-size: 11px; line-height: 16px; }',
      '[data-dscw-p-actrow]::before { content: ""; position: absolute; left: 3px; top: 0; bottom: 0; width: 1px; background: var(--dsw-alias-border-l3); }',
      '[data-dscw-p-actrow] [data-dot] { position: absolute; left: 1px; top: 8px; width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-1, transparent); }',
      '[data-dscw-p-actrow] [data-stage] { flex: none; padding: 0 4px; border-radius: 3px; font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 12%, transparent); font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); }',
      '[data-dscw-p-actrow] [data-text] { min-width: 0; color: var(--dsw-alias-label-secondary); word-break: break-word; }',
      '[data-dscw-p-actrow][data-tone="ok"] [data-dot] { background: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-tertiary)); }',
      '[data-dscw-p-actrow][data-tone="warn"] [data-dot] { background: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-tertiary)); }',
      '[data-dscw-p-actrow][data-tone="warn"] [data-text] { color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-p-actrow][data-tone="error"] [data-dot] { background: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-tertiary)); }',
      '[data-dscw-p-actrow][data-tone="error"] [data-text] { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-engine-log] { margin-top: 2px; }',
      '[data-dscw-p-engine-log] > summary { cursor: pointer; user-select: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }',
      '[data-dscw-p-engine-log] > div { max-height: 180px; overflow-y: auto; margin-top: 4px; padding-left: 8px; border-left: 2px solid var(--dsw-alias-border-l3); }',
      '[data-dscw-p-logline] { font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 10.5px; line-height: 15px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-all; font-variant-numeric: tabular-nums; }',
      '[data-dscw-p-queueahead] { font-size: 11px; line-height: 16px; color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)); word-break: break-all; }',

      // 会话视图（LLM 请求记录）
      // 会话行：去掉每行一个边框，改成列表 + 左侧状态色细条。请求动辄几十条，
      // 每行都描边就变成一叠同样重的框，扫不出「哪条还在跑、哪条出错了」。
      // 工作区分组：一组一个 <details>，头部是仓库名 + 条数。组间只留 2px，
      // 组内行不再画分隔线——分组本身已经是边界，再画线会得到两层框套。
      '[data-dscw-p-sessgroups] { display: flex; flex-direction: column; gap: 2px; }',
      '[data-dscw-p-sessgroup] > summary { display: flex; align-items: baseline; gap: 8px; padding: 5px 2px 4px; cursor: pointer; list-style: none; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-p-sessgroup] > summary::-webkit-details-marker { display: none; }',
      '[data-dscw-p-sessgroup] > summary [data-repo] { font-weight: 500; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '[data-dscw-p-sessgroup] > summary [data-count] { margin-left: auto; flex: none; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }',
      '[data-dscw-p-sessgroup][open] > summary { border-bottom: 0.5px solid var(--dsw-alias-border-l3); margin-bottom: 2px; }',
      '[data-dscw-p-sesslist] { display: flex; flex-direction: column; margin-top: 4px; }',
      '[data-dscw-p-sessrow] { position: relative; display: flex; gap: 8px; align-items: baseline; width: 100%; text-align: left; border: 0; border-radius: 6px; background: transparent; padding: 6px 8px 6px 12px; cursor: pointer; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary); transition: background-color .14s ease; }',
      '[data-dscw-p-sessrow]::before { content: ""; position: absolute; left: 3px; top: 7px; bottom: 7px; width: 2px; border-radius: 1px; background: var(--dsw-alias-border-l3); }',
      '[data-dscw-p-sessrow][data-status="running"]::before { background: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)); }',
      '[data-dscw-p-sessrow][data-status="error"]::before { background: var(--dsw-alias-state-error-primary, var(--dsw-alias-border-l3)); }',
      '[data-dscw-p-sessrow]:hover { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 70%, transparent); }',
      '[data-dscw-p-sessrow]:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }',
      '[data-dscw-p-sessrow] [data-mark] { flex: none; width: 12px; }',
      '[data-dscw-p-sessrow][data-status="running"] [data-mark] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); animation: dscw-pulse 1.2s ease-in-out infinite; }',
      '[data-dscw-p-sessrow][data-status="done"] [data-mark] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-sessrow][data-status="error"] [data-mark] { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-sessrow] [data-mark] { flex: none; width: 11px; text-align: center; font-size: 10px; }',
      '[data-dscw-p-sessrow] [data-name] { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }',
      '[data-dscw-p-sessrow] [data-sub] { flex: none; margin-left: auto; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }',
      '[data-dscw-p-sessitem] { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }',
      '[data-dscw-p-sessbody] { font-size: 11px; line-height: 16px; }',
      '[data-dscw-p-sessbody] summary { cursor: pointer; user-select: none; color: var(--dsw-alias-label-tertiary); }',
      '[data-dscw-p-sessbody] pre { max-height: 300px; overflow: auto; margin: 5px 0 0; padding: 9px 10px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, transparent); color: var(--dsw-alias-label-secondary); font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 10.5px; line-height: 16px; white-space: pre-wrap; word-break: break-word; }',
      '[data-dscw-p-sessbody] > summary { display: flex; align-items: center; gap: 6px; padding: 5px 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); list-style: none; }',
      '[data-dscw-p-sessbody] > summary::-webkit-details-marker { display: none; }',
      '[data-dscw-p-sessbody] > summary::before { content: "\u25b8"; font-size: 9px; color: var(--dsw-alias-label-tertiary); transition: transform .16s ease; }',
      '[data-dscw-p-sessbody][open] > summary::before { transform: rotate(90deg); }',
      // 会话视图嵌进 tab 时：不占满高度、不自己滚（否则双层滚动把列表压成一条缝）
      '[data-dscw-p-sesswrap] { display: flex; flex-direction: column; gap: 8px; min-width: 0; }',
      '[data-dscw-p-sessbar] { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-p-sessbar] > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '@keyframes dscw-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }',
    ].join('\n')
    // HMR/重复加载时避免堆叠重复样式表
    if (!document.head.querySelector('style[data-plugin="@local/dsh-codewiki"]')) document.head.appendChild(style)

    function el(tag, props, ...children) {
      return React.createElement(tag, props, ...children)
    }

    async function apiGet(p) {
      const res = await fetch(p, { headers: { accept: 'application/json' } })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    }
    async function apiPost(p, data) {
      const res = await fetch(p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(data ?? {}),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const tBound = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh: zh(), en: en() }), 'dscw: dictionaries')

        // 配置表单：宿主半侧 Config service 服务 'codewiki' 命名空间后即可读写。
        const form = ctx.configForms.get(NS)

        // 宿主服务该命名空间期间才出现（插件未加载/停用时插件页不显形）。
        const mount = () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: NS,
          order: 30,
          label: () => tBound('title'),
          locale: NS,
          inject: () => ({ t: tBound }),
        }, CodewikiCard))
        if (typeof ctx.configForms.whileServed === 'function') {
          ctx.effect(() => ctx.configForms.whileServed([NS], mount), 'dscw: plugins.item')
        } else {
          mount()
        }

        // 侧边栏面板：main slot 渲染任务列表，panellist 出入口（id 必须等于 main 的 key）。
        ctx.effect(() => {
          const disposers = [
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: KEY }, CodewikiPanel)),
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
              name: 'sidebar.panellist',
              id: KEY,
              order: PANEL_ORDER,
              label: () => tBound('title'),
            }, PanelIcon)),
          ]
          return () => disposers.forEach((d) => { try { d?.() } catch { /* 已卸载亦可 */ } })
        }, 'dscw: panel')

        // -------------------------------------------------------------------
        // 设置卡片组件（view='summary' 一行简介；view='page' 完整表单）
        // -------------------------------------------------------------------

        // 设置页可自动保存的字段表：新增字段必须同时进这里与渲染，否则改了不会落盘。
        const SAVE_KEYS = [
          'enabled', 'binaryPath', 'maxConcurrency', 'moduleConcurrency', 'bigConcurrency',
          'serialProjects', 'parallelProjects', 'articleLanguage', 'updateReminder', 'autoCommit',
          'workspaceOnly', 'batchProvider', 'batchModel', 'batchReasoningEffort',
          'bigProvider', 'bigModel', 'bigReasoningEffort', 'bigTokenBudget', 'excludePaths',
          'autoUpdate', 'autoUpdateMin', 'bigEnabled', 'requestLimit',
          'nativeEngine', 'nativeEnginePython', 'nativeEngineEntry', 'nativeEngineTimeoutMs',
          'updateRung', 'updateTauNb', 'updateTauGrow', 'updateTauFull', 'updateTauTree',
        ]

        function CodewikiCard(props) {
          const t = props?.t ?? tBound

          const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
          const [draft, setDraft] = React.useState(null)
          const [error, setError] = React.useState(null)
          // 模型目录（宿主 llm 服务的 provider/model，经 /api/codewiki/models 拉取）。
          // 拉不到时 catalogError 有值，设置页退回「手填」形态，不阻断保存。
          const [catalog, setCatalog] = React.useState(null)
          const [catalogError, setCatalogError] = React.useState(null)

          React.useEffect(() => {
            let alive = true
            apiGet(MODELS_PATH)
              .then((data) => {
                if (!alive) return
                if (data?.ok === false) { setCatalogError(String(data.error ?? '模型目录不可用')); return }
                setCatalog(Array.isArray(data?.providers) ? data.providers : [])
                setCatalogError(null)
              })
              .catch((err) => { if (alive) setCatalogError(String(err?.message ?? err)) })
            return () => { alive = false }
          }, [])

          // 配置快照 + 订阅：宿主值变更（含保存成功后的回收读）才覆盖草稿。
          React.useEffect(() => {
            let alive = true
            let lastRevision
            const pull = () => {
              if (!alive) return
              const snap = form.getSnapshot()
              setSnapshot(snap)
              if (snap.status === 'ready' && snap.value && typeof snap.value === 'object'
                && lastRevision !== snap.revision) {
                lastRevision = snap.revision
                setDraft(structuredClone(snap.value))
                setError(null)
              }
            }
            pull()
            const dispose = form.subscribe(pull)
            return () => { alive = false; dispose() }
          }, [])

          // 摘要视图：一行简介（插件页列表项）。
          if (props?.view === 'summary') return t('summary')

          const setPath = (key, value) => {
            setDraft((prev) => {
              if (!prev) return prev
              const next = structuredClone(prev)
              next[key] = value
              return next
            })
          }


          // 当前选中的提供商条目（目录里没命中时为 null = 手填形态）
          const selectedProvider = React.useMemo(() => {
            const id = String(draft?.batchProvider ?? '').trim()
            if (!id || !Array.isArray(catalog)) return null
            return catalog.find((p) => p?.id === id) ?? null
          }, [draft?.batchProvider, catalog])

          // 思考程度档位：选中 provider/model 后二次拉取 /api/codewiki/model-efforts，
          // 档位清单来自模型目录（resolveModelInfo 的 reasoning.efforts），不手填裸字符串。
          // 普通档（batch）与大档（big）各一份，同一套读取逻辑。
          const useEfforts = (provider, model) => {
            const [state, setState] = React.useState({ for: '', efforts: [], defaultEffort: null, error: null, loading: false })
            const p = String(provider ?? '').trim()
            const m = String(model ?? '').trim()
            React.useEffect(() => {
              if (!p || !m) { setState({ for: '', efforts: [], defaultEffort: null, error: null, loading: false }); return }
              const key = `${p}\u0000${m}`
              let alive = true
              setState((prev) => (prev.for === key ? prev : { for: key, efforts: [], defaultEffort: null, error: null, loading: true }))
              const url = `${EFFORTS_PATH}?provider=${encodeURIComponent(p)}&model=${encodeURIComponent(m)}`
              apiGet(url)
                .then((data) => {
                  if (!alive) return
                  if (data?.ok === false) {
                    setState({ for: key, efforts: [], defaultEffort: null, error: String(data.error ?? '不可用'), loading: false })
                    return
                  }
                  setState({
                    for: key,
                    efforts: Array.isArray(data?.efforts) ? data.efforts : [],
                    defaultEffort: data?.defaultEffort ? String(data.defaultEffort) : null,
                    error: null,
                    loading: false,
                  })
                })
                .catch((err) => {
                  if (alive) setState({ for: key, efforts: [], defaultEffort: null, error: String(err?.message ?? err), loading: false })
                })
              return () => { alive = false }
            }, [p, m])
            return state
          }
          const effortsState = useEfforts(draft?.batchProvider, draft?.batchModel)
          const bigEffortsState = useEfforts(draft?.bigProvider, draft?.bigModel)

          // 一个模型的三个字段（提供商 / 模型 / 思考程度），普通档与大档共用同一套渲染与
          // 目录联动：换提供商清空模型与旧档位、目录里的模型下拉、档位来自 model-efforts 端点。
          // allowEmptyProvider=true 时多给一个「（未启用）」空选项：大档关闭时不必填提供商，
          // 空值只表示「这条任务不走指定 provider」，开关本身是 bigEnabled。
          const modelTrio = ({ pKey, mKey, eKey, state, allowEmptyProvider, providerPlaceholder }) => {
            const currentProvider = String(draft[pKey] ?? '').trim()
            const entry = Array.isArray(catalog) ? catalog.find((p) => p?.id === currentProvider) : null
            const models = entry?.models
            const current = String(draft[eKey] ?? '')
            return [
              el('label', null, t(pKey)),
              el('div', { 'data-dscw-field': '' },
                catalogError
                  ? el(Input, {
                      value: String(draft[pKey] ?? ''),
                      onChange: (e) => setPath(pKey, e.target.value),
                      placeholder: providerPlaceholder,
                    })
                  : el('select', {
                      'data-dscw-select': '',
                      value: String(draft[pKey] ?? ''),
                      onChange: (e) => {
                        const next = e.target.value
                        setPath(pKey, next)
                        // 换提供商时把模型清空，避免残留上一家的模型 id 被误存
                        const nextEntry = Array.isArray(catalog) ? catalog.find((p) => p?.id === next) : null
                        setPath(mKey, nextEntry?.models?.[0]?.id ?? '')
                        setPath(eKey, '') // 换模型后旧档位可能不存在
                      },
                    },
                    ...(allowEmptyProvider ? [el('option', { key: '__none', value: '' }, t('bigProviderOff'))] : []),
                    (Array.isArray(catalog) ? catalog : []).map((p) => el('option', { key: p.id, value: p.id }, p.name && p.name !== p.id ? `${p.name}（${p.id}）` : p.id)),
                    // 已配置但目录里没有的 provider（例如刚删掉的渠道）：保留选项，避免静默丢失配置
                    currentProvider && !(Array.isArray(catalog) ? catalog : []).some((p) => p?.id === currentProvider)
                      ? el('option', { key: '__custom', value: currentProvider }, currentProvider)
                      : null,
                  ),
                el('div', { 'data-dscw-hint': '' }, catalogError
                  ? t('catalogUnavailable').replace('{error}', catalogError)
                  : t(`${pKey}Hint`)),
              ),
              el('label', null, t(mKey)),
              el('div', { 'data-dscw-field': '' },
                (!currentProvider || !Array.isArray(models) || !models.length)
                  ? el(Input, {
                      value: String(draft[mKey] ?? ''),
                      onChange: (e) => setPath(mKey, e.target.value),
                      placeholder: t('batchModelManual'),
                    })
                  : (() => {
                      const known = models.some((m) => m.id === String(draft[mKey] ?? ''))
                      return el('select', {
                        'data-dscw-select': '',
                        value: String(draft[mKey] ?? ''),
                        onChange: (e) => setPath(mKey, e.target.value),
                      },
                        ...(known ? [] : [el('option', { key: '__custom', value: String(draft[mKey] ?? '') }, String(draft[mKey] ?? ''))]),
                        models.map((m) => el('option', { key: m.id, value: m.id }, m.name && m.name !== m.id ? `${m.name}（${m.id}）` : m.id)),
                      )
                    })(),
                el('div', { 'data-dscw-hint': '' }, entry && Array.isArray(entry.models) && !entry.models.length
                  ? t('catalogEmptyModels')
                  : t(`${mKey}Hint`)),
              ),
              el('label', null, t(eKey)),
              el('div', { 'data-dscw-field': '' },
                (() => {
                  if (!currentProvider && allowEmptyProvider) return el('div', { 'data-dscw-hint': '' }, t('bigDisabled'))
                  if (!currentProvider) return el('div', { 'data-dscw-hint': '' }, t('batchReasoningEffortNone'))
                  if (state.loading && !state.efforts.length) return el('div', { 'data-dscw-hint': '' }, t('batchReasoningEffortLoading'))
                  if (state.error) return el('div', { 'data-dscw-hint': '' }, t('batchReasoningEffortError').replace('{error}', state.error))
                  if (!state.efforts.length) {
                    // 目录未声明可选档位：不再锁死「默认」，给通用档位手动选；
                    // 选了模型不支持的值由 llmChat 兜底剥档重试，不会失败
                    return el('div', { 'data-dscw-field': '' },
                      el('select', {
                        'data-dscw-select': '',
                        value: current,
                        onChange: (e) => setPath(eKey, e.target.value),
                      },
                        el('option', { value: '' }, t('batchReasoningEffortModel')),
                        ...(GENERIC_EFFORTS.includes(current) ? [] : current
                          ? [el('option', { key: '__custom', value: current }, current)]
                          : []),
                        GENERIC_EFFORTS.map((e) => el('option', { key: e, value: e }, e)),
                      ),
                      el('div', { 'data-dscw-hint': '' }, t('batchReasoningEffortGeneric')),
                    )
                  }
                  const known = !current || state.efforts.some((e) => e.id === current)
                  const labelOf = (e) => (e.description ? `${e.name}（${e.id}）— ${e.description}` : (e.name && e.name !== e.id ? `${e.name}（${e.id}）` : e.id))
                  return el('div', { 'data-dscw-field': '' },
                    el('select', {
                      'data-dscw-select': '',
                      value: current,
                      onChange: (e) => setPath(eKey, e.target.value),
                    },
                      el('option', { value: '' }, state.defaultEffort
                        ? `${t('batchReasoningEffortModel')}（${state.defaultEffort}）`
                        : t('batchReasoningEffortModel')),
                      ...(known ? [] : [el('option', { key: '__custom', value: current }, current)]),
                      state.efforts.map((e) => el('option', { key: e.id, value: e.id }, labelOf(e))),
                    ),
                    el('div', { 'data-dscw-hint': '' }, t(`${eKey}Hint`)),
                  )
                })(),
              ),
            ]
          }

          // 自动保存：字段改动后 500ms 提交一次，界面上不再有「保存 / 放弃更改」。
          // 保存条上的按钮只在两种情况下有意义——「忘了按」「按错了」——而两者都是
          // 因为存在一个需要人记住的手动步骤。改成自动后这类失误结构性消失。
          // 策略：串行提交（上一次 mutate 未回读完成就不并发），pendingRef 保留最新草稿，
          // 保存期间又改动则再排一次；校验不过的字段不提交，错误常显在底部状态行。
          const pendingRef = React.useRef(null)
          const savingRef = React.useRef(false)
          const timerRef = React.useRef(null)
          const [saveState, setSaveState] = React.useState('idle') // idle | saving | saved | error

          const validateDraft = (d) => {
            const concurrency = Number(d?.maxConcurrency)
            if (Number.isFinite(concurrency) && (concurrency < 1 || concurrency > 8 || !Number.isInteger(concurrency))) return t('invalidConcurrency')
            // 大档并发：0 = 跟随默认档；负值/小数/超硬顶一律拦下（0 留给「跟随」语义，不报错）
            const bigConc = Number(d?.bigConcurrency)
            if (Number.isFinite(bigConc) && bigConc !== 0 && (bigConc < 1 || bigConc > 8 || !Number.isInteger(bigConc))) return t('invalidConcurrency')
            // 单模块请求上限：拦住非整数与越界，避免 0 或负数被当成「不限制」
            const reqLimit = Number(d?.requestLimit)
            if (!Number.isInteger(reqLimit) || reqLimit < 1 || reqLimit > 1000) return t('invalidRequestLimit')
            return null
          }

          const flush = async () => {
            const d = pendingRef.current
            if (!d || savingRef.current) return
            const snap = form.getSnapshot()
            if (snap.status !== 'ready' || !snap.writable) return
            const bad = validateDraft(d)
            if (bad) { setError(bad); setSaveState('error'); return }
            const base = snap.value ?? {}
            const ops = []
            for (const key of SAVE_KEYS) {
              if (JSON.stringify(d?.[key]) !== JSON.stringify(base[key])) {
                ops.push({ op: 'set', path: [key], value: d?.[key] })
              }
            }
            if (!ops.length) return
            savingRef.current = true
            setSaveState('saving')
            try {
              const accepted = await form.mutate(ops, snap.revision)
              if (accepted) { setError(null); setSaveState('saved') } else { setSaveState('error') }
            } catch (err) {
              setSaveState('error')
              setError(String(err?.message ?? err))
            } finally {
              savingRef.current = false
              // 保存期间用户又改了：pending 已换成新草稿，用一次新排期把它送出去
              if (pendingRef.current !== d) scheduleSave()
            }
          }

          const scheduleSave = () => {
            if (timerRef.current) clearTimeout(timerRef.current)
            timerRef.current = setTimeout(() => { timerRef.current = null; void flush() }, 500)
            // unref：Node 测试环境里不让这个定时器吊住进程；浏览器 setTimeout 无此方法
            timerRef.current?.unref?.()
          }

          // 草稿与已保存值不同就排一次保存。用 JSON 比较而不是 dirty：
          // 自动保存跑在 effect 里，dirty 的 memo 可能滞后一帧，比出「同值」会漏存。
          React.useEffect(() => {
            if (!draft || !snapshot?.value) return
            if (JSON.stringify(draft) === JSON.stringify(snapshot.value)) return
            pendingRef.current = draft
            scheduleSave()
          }, [draft, snapshot?.value])

          React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

          // 卸载前把未落盘的草稿补提交一次：面板切走/折叠时用户不该丢掉刚改的值
          React.useEffect(() => () => { void flush() }, [])

          if (snapshot.status === 'loading' || snapshot.status === 'unavailable' || !draft) {
            return el('div', { 'data-dscw-page': '' }, el('div', { 'data-dscw-notice': '' }, t('loadingLabel')))
          }

          return el('div', { 'data-dscw-page': '' },
            el('div', { 'data-dscw-hint': '' }, t('intro')),
            // 运行
            el('div', { 'data-dscw-cards': '' },
              el('section', { 'data-dscw-sec': '' },
                el('div', { 'data-dscw-head': '' }, el('h4', null, t('secRun'))),
                el('div', { 'data-dscw-grid': '' },
                  el('div', { 'data-dscw-toggle': '' },
                    el('label', null, t('enabled')),
                    el(Switch, {
                      checked: draft.enabled !== false,
                      onChange: (v) => setPath('enabled', v),
                      label: t('enabled'),
                    })
                  ),
                  el('div', { 'data-dscw-hint': '' }, t('enabledHint')),
                  el('div', { 'data-dscw-toggle': '' },
                    el('label', null, t('updateReminder')),
                    el(Switch, {
                      checked: draft.updateReminder !== false,
                      onChange: (v) => setPath('updateReminder', v),
                      label: t('updateReminder'),
                    })
                  ),
                  el('div', { 'data-dscw-hint': '' }, t('updateReminderHint')),
                  el('div', { 'data-dscw-toggle': '' },
                    el('label', null, t('autoCommit')),
                    el(Switch, {
                      checked: draft.autoCommit !== false,
                      onChange: (v) => setPath('autoCommit', v),
                      label: t('autoCommit'),
                    })
                  ),
                  el('div', { 'data-dscw-hint': '' }, t('autoCommitHint')),
                  el('div', { 'data-dscw-toggle': '' },
                    el('label', null, t('workspaceOnly')),
                    el(Switch, {
                      checked: draft.workspaceOnly !== false,
                      onChange: (v) => setPath('workspaceOnly', v),
                      label: t('workspaceOnly'),
                    })
                  ),
                  el('div', { 'data-dscw-hint': '' }, t('workspaceOnlyHint')),
                ),
              ),
              // 并发与语言：决定同时开多少条请求、同时推进几个仓库、写什么语言的文章。
              // 和上面的行为开关分开放——它们是「怎么跑」，开关是「要不要跑」。
              el('section', { 'data-dscw-sec': '' },
                el('div', { 'data-dscw-head': '' }, el('h4', null, t('secScale'))),
                el('div', { 'data-dscw-grid': '' },
                  el('label', null, t('maxConcurrency')),
                  el('div', { 'data-dscw-field': '' },
                    el(Input, {
                      value: String(draft.maxConcurrency ?? 2),
                      onChange: (e) => setPath('maxConcurrency', Number(e.target.value)),
                      placeholder: '2',
                    }),
                    el('div', { 'data-dscw-hint': '' }, t('maxConcurrencyHint')),
                  ),
                  el('label', null, t('moduleConcurrency')),
                  el('div', { 'data-dscw-field': '' },
                    el(Input, {
                      type: 'number', min: 0, max: 8, step: 1,
                      value: String(draft.moduleConcurrency ?? 0),
                      onChange: (e) => setPath('moduleConcurrency', e.target.value === '' ? 0 : Number(e.target.value)),
                      placeholder: '0',
                    }),
                    el('div', { 'data-dscw-hint': '' }, t('moduleConcurrencyHint')),
                  ),
                  el('div', { 'data-dscw-toggle': '' },
                    el('label', null, t('serialProjects')),
                    el(Switch, {
                      checked: draft.serialProjects !== false,
                      onChange: (v) => setPath('serialProjects', v),
                      label: t('serialProjects'),
                    })
                  ),
                  el('div', { 'data-dscw-hint': '' }, t('serialProjectsHint')),
                  el('label', null, t('parallelProjects')),
                  el('div', { 'data-dscw-field': '' },
                    el(Input, {
                      type: 'number', min: 1, max: 4, step: 1,
                      disabled: draft.serialProjects !== false,
                      value: String(draft.parallelProjects ?? 2),
                      onChange: (e) => setPath('parallelProjects', Math.max(1, Math.min(4, Number(e.target.value) || 2))),
                    }),
                    el('div', { 'data-dscw-hint': '' }, t('parallelProjectsHint')),
                  ),
                  el('label', null, t('articleLanguage')),
                  el('div', { 'data-dscw-field': '' },
                    el(Input, {
                      value: String(draft.articleLanguage ?? ''),
                      onChange: (e) => setPath('articleLanguage', e.target.value),
                      placeholder: '中文',
                    }),
                    el('div', { 'data-dscw-hint': '' }, t('articleLanguageHint')),
                  ),
                  el('label', null, t('binaryPath')),
                  el('div', { 'data-dscw-field': '' },
                    el(Input, {
                      value: String(draft.binaryPath ?? ''),
                      onChange: (e) => setPath('binaryPath', e.target.value),
                      placeholder: 'C:\\…\\cw.exe',
                    }),
                    el('div', { 'data-dscw-hint': '' }, t('binaryPathHint')),
                  ),
                ),
              ),
              // 原生引擎：决定走 FSoft 原生流水线还是内置 Node 兼容通道，以及引擎的
              // Python 解释器、入口脚本与超时。这四项此前只能改配置文件。
              el('section', { 'data-dscw-sec': '' },
                el('div', { 'data-dscw-head': '' }, el('h4', null, t('secNative'))),
                el('div', { 'data-dscw-hint': '' }, t('secNativeHint')),
                el('div', { 'data-dscw-grid': '' },
                  el('div', { 'data-dscw-toggle': '' },
                    el('label', null, t('nativeEngine')),
                    el(Switch, {
                      checked: draft.nativeEngine !== false,
                      onChange: (v) => setPath('nativeEngine', v),
                      label: t('nativeEngine'),
                    })
                  ),
                  el('div', { 'data-dscw-hint': '' }, t('nativeEngineHint')),
                  el('label', null, t('nativeEnginePython')),
                  el('div', { 'data-dscw-field': '' },
                    el(Input, {
                      value: String(draft.nativeEnginePython ?? ''),
                      onChange: (e) => setPath('nativeEnginePython', e.target.value),
                      placeholder: 'C:\\\\…\\\\python.exe',
                    }),
                    el('div', { 'data-dscw-hint': '' }, t('nativeEnginePythonHint')),
                  ),
                  el('label', null, t('nativeEngineEntry')),
                  el('div', { 'data-dscw-field': '' },
                    el(Input, {
                      value: String(draft.nativeEngineEntry ?? ''),
                      onChange: (e) => setPath('nativeEngineEntry', e.target.value),
                      placeholder: 'lib/engine/python/entry.py',
                    }),
                    el('div', { 'data-dscw-hint': '' }, t('nativeEngineEntryHint')),
                  ),
                  el('label', null, t('nativeEngineTimeoutMs')),
                  el('div', { 'data-dscw-field': '' },
                    el(Input, {
                      type: 'number', min: 0, step: 60000,
                      value: String(draft.nativeEngineTimeoutMs ?? 0),
                      onChange: (e) => setPath('nativeEngineTimeoutMs', e.target.value === '' ? 0 : Number(e.target.value)),
                    }),
                    el('div', { 'data-dscw-hint': '' }, t('nativeEngineTimeoutMsHint')),
                  ),
                ),
              ),
              // 增量策略：档位与四个阈值。全部可选——留空即用上游默认值，
              // 因此这里不写默认值到配置里，避免把上游默认「焊死」在插件侧。
              el('section', { 'data-dscw-sec': '' },
                el('div', { 'data-dscw-head': '' }, el('h4', null, t('secIncremental'))),
                el('div', { 'data-dscw-hint': '' }, t('secIncrementalHint')),
                el('div', { 'data-dscw-grid': '' },
                  el('label', null, t('updateRung')),
                  el('div', { 'data-dscw-field': '' },
                    el('select', {
                      'data-dscw-select': '',
                      value: String(draft.updateRung ?? ''),
                      onChange: (e) => setPath('updateRung', e.target.value),
                    },
                      el('option', { key: '__default', value: '' }, t('updateRungDefault')),
                      ...['3', '3b', '2', '1', '0'].map((r) => el('option', { key: r, value: r }, `rung ${r}`)),
                    ),
                    el('div', { 'data-dscw-hint': '' }, t('updateRungHint')),
                  ),
                  ...['updateTauNb', 'updateTauGrow', 'updateTauFull', 'updateTauTree'].map((k) => (
                    el('div', { key: k, 'data-dscw-pair': '' },
                      el('label', null, t(k)),
                      el('div', { 'data-dscw-field': '' },
                        el(Input, {
                          type: 'number', min: 0, max: 1, step: 0.05,
                          value: String(draft[k] ?? ''),
                          onChange: (e) => setPath(k, e.target.value),
                          placeholder: t('updateTauDefault'),
                        }),
                        el('div', { 'data-dscw-hint': '' }, t(`${k}Hint`)),
                      ),
                    )
                  )),
                ),
              ),
              // 编译模型（唯一通道：模型设置里已注册的 provider/model）
              el('section', { 'data-dscw-sec': '' },
                el('div', { 'data-dscw-head': '' }, el('h4', null, t('secCompile'))),
                el('div', { 'data-dscw-hint': '' }, t('secCompileHint')),
                el('div', { 'data-dscw-grid': '' },
                  ...modelTrio({ pKey: 'batchProvider', mKey: 'batchModel', eKey: 'batchReasoningEffort', state: effortsState, allowEmptyProvider: false, providerPlaceholder: 'workbuddy' }),
                  el('label', null, t('requestLimit')),
                  el('div', { 'data-dscw-field': '' },
                    el(Input, {
                      type: 'number', min: 1, max: 1000, step: 50,
                      value: String(draft.requestLimit ?? 100),
                      onChange: (e) => setPath('requestLimit', e.target.value === '' ? 0 : Number(e.target.value)),
                    }),
                    el('div', { 'data-dscw-hint': '' }, t('requestLimitHint')),
                  ),
                ),
              ),
              // 大档模型（超长输入）：超过普通档单请求预算的模块改用它，仍全部在插件内完成。
              // bigEnabled 是唯一开关（0.17.5 前靠 bigProvider 留空隐式关闭）：关掉后整组字段
              // 收起，但取值保留在配置里，重新开启不用重填。
              el('section', { 'data-dscw-sec': '' },
                el('div', { 'data-dscw-head': '' }, el('h4', null, t('secBig'))),
                el('div', { 'data-dscw-hint': '' }, t('secBigHint')),
                el('div', { 'data-dscw-grid': '' },
                  el('div', { 'data-dscw-toggle': '' },
                    el('label', null, t('bigEnabled')),
                    el(Switch, {
                      checked: draft.bigEnabled !== false,
                      onChange: (v) => setPath('bigEnabled', v),
                      label: t('bigEnabled'),
                    })
                  ),
                  el('div', { 'data-dscw-hint': '' }, t('bigEnabledHint')),
                  ...(draft.bigEnabled !== false
                    ? [
                      ...modelTrio({ pKey: 'bigProvider', mKey: 'bigModel', eKey: 'bigReasoningEffort', state: bigEffortsState, allowEmptyProvider: true, providerPlaceholder: 'volces-ark' }),
                      el('label', null, t('bigTokenBudget')),
                      el('div', { 'data-dscw-field': '' },
                        el(Input, {
                          value: String(draft.bigTokenBudget ?? ''),
                          onChange: (e) => setPath('bigTokenBudget', e.target.value === '' ? 0 : Number(e.target.value)),
                          placeholder: '420000',
                        }),
                        el('div', { 'data-dscw-hint': '' }, t('bigTokenBudgetHint')),
                      ),
                      el('label', null, t('bigConcurrency')),
                      el('div', { 'data-dscw-field': '' },
                        el(Input, {
                          type: 'number', min: 0, max: 8, step: 1,
                          value: String(draft.bigConcurrency ?? 0),
                          onChange: (e) => setPath('bigConcurrency', Number(e.target.value) || 0),
                        }),
                        el('div', { 'data-dscw-hint': '' }, t('bigConcurrencyHint')),
                      ),
                    ]
                    : []),
                ),
              ),
              // 调度与排除
              el('section', { 'data-dscw-sec': '' },
                el('div', { 'data-dscw-head': '' }, el('h4', null, t('secSchedule'))),
                el('div', { 'data-dscw-grid': '' },
                  el('div', { 'data-dscw-toggle': '' },
                    el('label', null, t('autoUpdateLabel')),
                    el(Switch, {
                      checked: draft.autoUpdate === true,
                      onChange: (v) => setPath('autoUpdate', v),
                      label: t('autoUpdateLabel'),
                    })
                  ),
                  el('div', { 'data-dscw-hint': '' }, t('autoUpdateLabelHint')),
                  el('label', null, t('autoUpdateMinLabel')),
                  el('div', { 'data-dscw-field': '' },
                    el(Input, {
                      value: String(draft.autoUpdateMin ?? 30),
                      onChange: (e) => setPath('autoUpdateMin', Number(e.target.value)),
                      placeholder: '30',
                    }),
                    el('div', { 'data-dscw-hint': '' }, t('autoUpdateMinHint')),
                  ),
                  el('label', null, t('excludePathsLabel')),
                  el('div', { 'data-dscw-field': '' },
                    el('textarea', {
                      'data-dscw-p-textarea': '',
                      value: String(draft.excludePaths ?? ''),
                      onChange: (e) => setPath('excludePaths', e.target.value),
                      placeholder: 'E:\\path\\to\\excluded-repo',
                    }),
                    el('div', { 'data-dscw-hint': '' }, t('excludePathsHint')),
                  ),
                ),
              ),
            ),
            // 自动保存状态行：不再有按钮，只报「现在是什么状态」。
            // 校验失败时把「重试」摆出来——自动保存不会因为一次校验错就停滞不前，
            // 但用户需要一个明确的动作把修正后的值立刻送出，而不是等下一轮 500ms。
            el('div', { 'data-dscw-bar': '', 'data-state': error ? 'error' : saveState, title: t('autoSaveHint') },
              el('span', { 'data-dscw-savestate': '' },
                error
                  ? error
                  : saveState === 'saving'
                    ? t('autoSaving')
                    : saveState === 'saved'
                      ? t('autoSaved')
                      : saveState === 'error'
                        ? t('autoSaveFailed')
                        : t('autoSaveIdle')),
              error ? el(Button, { variant: 'ghost', size: 'sm', onClick: () => { pendingRef.current = draft; void flush() } }, t('autoSaveRetry')) : null,
              !snapshot.writable ? el('span', { 'data-dscw-hint': '' }, t('readonlyHint')) : null,
            ),
          )
        }

        // -------------------------------------------------------------------
        // 侧边栏面板：编译任务进度 + 取消（轮询 jobs 端点）
        // -------------------------------------------------------------------

        const stageLabel = (stage) => tBound(`stage${String(stage).charAt(0).toUpperCase()}${String(stage).slice(1)}`)
        // 原生引擎阶段名（八段契约）。与面板六步阶段同名的那几个（articles/index/commit）
        // 直接映射回步骤条标签，避免同一阶段出现两种说法。
        const NATIVE_STAGE_KEYS = {
          env: 'nativeEnv', graph: 'nativeGraph', cluster: 'nativeCluster',
          articles: 'stageArticles', proofread: 'nativeProofread', validate: 'nativeValidate',
          index: 'stageIndex', baseline: 'nativeBaseline', commit: 'stageCommit',
        }
        const nativeStageName = (stage) => (stage && NATIVE_STAGE_KEYS[stage] ? tBound(NATIVE_STAGE_KEYS[stage]) : null)

        const stateLabel = (st) => tBound(`state${String(st).charAt(0).toUpperCase()}${String(st).slice(1)}`)
        const kindLabelOf = (t, kind) => t(`kind${String(kind).charAt(0).toUpperCase()}${String(kind).slice(1)}`)
        const progressBar = (done, total) => (total > 0
          ? el('div', { 'data-dscw-p-bar': '' },
            el('div', { 'data-dscw-p-barfill': '', style: { width: `${Math.max(0, Math.min(100, Math.round((done / total) * 100)))}%` } }))
          : null)
        const repoName = (cwd) => {
          const parts = String(cwd ?? '').split(/[\\/]/).filter(Boolean)
          return parts.slice(-2).join('/') || cwd // 父目录/目录名两段，Temp 沙箱残留一眼可辨
        }
        const fmtMs = (ms) => {
          const v = Math.max(0, Math.floor(ms))
          // 亚秒不折算成 00:00：索引、提交这类阶段常常几百毫秒，写成 00:00 等于没有读数。
          if (v < 1000) return `${v}ms`
          const s = Math.floor(v / 1000)
          const h = Math.floor(s / 3600)
          const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
          const ss = String(s % 60).padStart(2, '0')
          return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
        }
        // 加载骨架：三行不同宽度的呼吸条，替代光秃秃的「…」。
        const Skeleton = ({ rows = [100, 72, 46] }) =>
          el('div', { 'data-dscw-p-skel': '' },
            rows.map((w, i) => el('i', { key: i, 'data-w': String(w) })))

        // 活动流一条备注的结构化解读：语气（绿/黄/红）+ 阶段标签 + 去掉标签后的正文。
        // 备注本身是自由文本（`notes.push(...)` 各写各的），这里只做可证伪的轻量归约：
        // 命中不了任何关键字就按普通条目渲染，不猜。
        const ACTIVITY_TONES = [
          ['error', /失败|异常|超时|已回滚|无法|未过|不落盘|闸门|refused|failed|error/i],
          ['warn', /跳过|忽略|未消化|不推进|不重写|待提交|存疑|降级|退化为|空产出|排队等待|warning/i],
          ['ok', /完成|结束|已提交|已写|已刷新|开始|启动|命中|通过/i],
        ]
        const activityRow = (text) => {
          const s = String(text ?? "")
          let tone = 'plain'
          for (const [name, re] of ACTIVITY_TONES) {
            if (re.test(s)) { tone = name; break }
          }
          // 阶段标签：备注里常见「（articles）」「(articles)」「stage articles」三种写法。
          const m = s.match(/[（(]\s*([a-z][a-z_-]{2,14})\s*[)）]/i) ?? s.match(/\bstage[:= ]+([a-z][a-z_-]{2,14})\b/i)
          const stage = m ? m[1].toLowerCase() : null
          const body = stage ? s.replace(m[0], "").replace(/\s{2,}/g, " ").trim() : s
          return { tone, stage, text: body }
        }
        const fmtTok = (n) => {
          if (!Number.isFinite(n) || n <= 0) return null
          if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
          if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
          return String(Math.round(n))
        }
        const fmtDur = (ms) => {
          const m = Math.max(0, Math.round(ms / 60000))
          if (m < 60) return `${m} min`
          const h = Math.floor(m / 60)
          return `${h} h ${m % 60} min`
        }
        const fmtAgo = (iso) => {
          const ms = Date.now() - Date.parse(iso)
          return Number.isFinite(ms) && ms >= 0 ? `${fmtDur(ms)} ${tBound('agoSuffix')}` : null
        }
        // tps 微趋势线：纯 SVG polyline，数据来自面板侧滚动窗口（30 点）
        const Spark = ({ values, width = 56, height = 16 }) => {
          const pts = (values ?? []).filter((v) => Number.isFinite(v) && v > 0)
          if (pts.length < 2) return null
          const max = Math.max(...pts)
          const min = Math.min(...pts)
          const span = max - min || 1
          const step = width / (pts.length - 1)
          const d = pts
            .map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`)
            .join('')
          return el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, style: { flex: 'none' } },
            el('path', { d, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
        }

        // 六步步骤条（排队 + 五个真实阶段）：已完成绿点（title 带各阶段耗时）、
        // 当前阶段实心点+实时计时、失败/取消在最后计时段标红/黄。终态 done 全绿。
        const stepName = (s) => tBound(`step${s.charAt(0).toUpperCase()}${s.slice(1)}`)
        // 阶段耗时按「当前阶段名」取：历史任务里的键可能是已退役的 plan/crosscut。
        const timingsOf = (job) => {
          const out = {}
          for (const [k, v] of Object.entries(job.stageTimings ?? {})) out[LEGACY_STAGE[k] ?? k] = v
          return out
        }
        const lastTimedStage = (job) => {
          const keys = Object.keys(job.stageTimings ?? {}).map((k) => LEGACY_STAGE[k] ?? k)
            .filter((k) => ACTIVE_STAGES.includes(k))
          return keys.length ? keys[keys.length - 1] : null
        }
        // 引擎八段 → 面板五步。服务端用同一张表推 job.stage，这里用它把引擎自报的
        // 阶段百分比挂到对应步骤上，两边算出来的「当前在哪一步」才不会打架。
        // proofread 与 validate 都归 validate：前者是后者死链检查的修复动作。
        const NATIVE_TO_STEP = {
          env: 'prepare', graph: 'prepare', cluster: 'prepare',
          articles: 'articles', proofread: 'validate', validate: 'validate',
          index: 'index', baseline: 'index', commit: 'commit',
        }
        // 总进度：各阶段定权线性推进，阶段内按真实完成度折算；封顶 99，done/partial 才 100。
        // 权重对应五步里除排队外的四个真实阶段，总和为 1——漏一步或比例错，百分比就会在
        // 相邻两步之间凭空跳点。准备阶段（环境+代码图+聚类）在大仓库上最费时间，给到 0.24；
        // 校验段含死链校对（模型改写正文），在大仓上也不便宜，留 0.21。
        const STAGE_WEIGHTS = { queued: 0, prepare: 0.24, articles: 0.46, validate: 0.21, index: 0.05, commit: 0.04 }
        // 单个阶段自己的完成度（0..1）。这是「每个阶段显示自己的百分比」的唯一来源：
        // 已跑过=1，当前阶段优先用引擎自报的 nativePercent（同一段内最细的读数），
        // 退而用 taskList 的完成率，都没有就是 0（刚进入、还没产出任何可计数的东西）。
        const stageFraction = (job, stage, idx, curIdx, terminal) => {
          if (terminal) return 1
          if (idx < curIdx) return 1
          if (idx > curIdx) return 0
          if (NATIVE_TO_STEP[job.nativeStage] === stage && Number.isFinite(job.nativePercent)) {
            return Math.max(0, Math.min(100, job.nativePercent)) / 100
          }
          const tl = Array.isArray(job.taskList) ? job.taskList : []
          return tl.length ? tl.filter((x) => x.state === 'done').length / tl.length : 0
        }
        const stageRows = (job) => {
          const curIdx = ACTIVE_STAGES.indexOf(stageOf(job))
          const terminal = curIdx < 0
          // partial（部分完成）与 done 一样「所有阶段都跑过了」，区别只在终态标签与
          // 未消化变化的提示——所以步骤条不该停在某个阶段标红，只有 failed/cancelled 才这样。
          const cleanEnd = job.stage === 'done' || job.stage === 'partial'
          const failIdx = terminal && !cleanEnd ? ACTIVE_STAGES.indexOf(lastTimedStage(job)) : -1
          return ACTIVE_STAGES.map((s, i) => {
            const frac = stageFraction(job, s, i, curIdx, terminal)
            const done = terminal ? ((failIdx < 0 && cleanEnd) || i < failIdx) : i < curIdx
            const running = !terminal && i === curIdx
            const failedStep = terminal && failIdx >= 0 && i === failIdx
            const dur = timingsOf(job)[s]
            return { stage: s, frac, done, running, failedStep, dur }
          })
        }
        // 段宽的口径随任务状态切换，这是两条带子唯一的分歧点：
        //   进行中 → 进度权重（这一步占总进度的多少，和上面的总进度条同口径）；
        //   终态   → 该阶段真实耗时（占比就是「时间花在哪」，此时进度恒为 100% 毫无信息量）。
        // 走的是同一份 stageTimings，所以不存在「两套数字对不上」。
        // 排队不进带子：它是等别人，不是编译干了什么，且真机上常比整个编译还长——
        // 画进去会把真正的阶段全压成细线。排队时长在上面的用时行里单独报。
        const stageWeight = (job, stage, running) => {
          if (stage === 'queued') return 0
          if (running) return STAGE_WEIGHTS[stage] ?? 0
          const ms = timingsOf(job)[stage]
          return Number.isFinite(ms) && ms > 0 ? ms : 0
        }
        // 老任务没有 stageTimings（0.5.0 之前的记录），终态就别画一条全是 0 的空白带。
        const hasTimings = (job) => ACTIVE_STAGES.some((s) => s !== 'queued' && stageWeight(job, s, false) > 0)
        // 阶段可视化：一条分段带，段宽的含义见 stageWeight。早先是每阶段一行独立轨道，
        // 一张卡就吃掉 300px 高度，同一个信息用分段带表达只占 5px。
        // 0.17.46 起它不再另起一行——用户要的是「一条进度条，各截断按时间占比用不同颜色」，
        // 所以这条带直接就是主进度条本身，上面的 [data-dscw-p-bar] 只在没有分段信息时兜底。
        const stageSegments = (job, running) => {
          const rows = stageRows(job)
          const shown = rows.filter((r) => stageWeight(job, r.stage, running) > 0)
          return el('div', {
            'data-dscw-p-segbar': '', 'data-tone': job.stage,
            title: legendHintOf(job, running),
          },
            shown.map((r) => {
              const w = stageWeight(job, r.stage, running)
              const state = r.failedStep ? 'failed' : r.running ? 'running' : r.done ? 'done' : 'todo'
              const dur = timingsOf(job)[r.stage]
              return el('div', {
                key: r.stage, 'data-dscw-p-seg': '', 'data-state': state,
                style: { flex: `${w} 0 0`, '--seg-hue': String(STAGE_HUE[r.stage] ?? 210), '--seg-done': `${Math.round(r.frac * 100)}%` },
                title: running
                  ? `${stageLabel(r.stage)} · ${Math.round(r.frac * 100)}%${dur ? ` · ${fmtMs(dur)}` : ''}`
                  : `${stageLabel(r.stage)} · ${fmtMs(w)}`,
              })
            }))
        }
        const legendHintOf = (job, running) => (running ? tBound('legendHint') : tBound('legendHintDone'))
        // 图例：每个阶段一个小标签，只写「阶段名 读数」，当前阶段加粗。
        // 一行放得下就一行，放不下就换行——比逐行轨道省一个数量级的高度。
        // 读数进行中是完成百分比，终态是该阶段耗时：「跑完了」这件事看一次就够，
        // 真正无法从别处得到的信息是「时间花在哪一步」。
        const stageLegend = (job, running) => {
          const rows = stageRows(job).filter((r) => stageWeight(job, r.stage, running) > 0)
          // 色块是颜色与阶段之间唯一的绑定：色块色相与上方进度条里那一段完全一致，
          // 所以「哪段是什么」不用去猜——照着色块找同色的段即可。
          return el('div', {
            'data-dscw-p-legend': '',
            title: legendHintOf(job, running),
          },
            rows.map((r) => {
              const state = r.failedStep ? 'failed' : r.running ? 'running' : r.done ? 'done' : 'todo'
              const pct = Math.round(r.frac * 100)
              const dur = timingsOf(job)[r.stage]
              return el('span', {
                key: r.stage, 'data-state': state,
                style: { '--seg-hue': String(STAGE_HUE[r.stage] ?? 210) },
                // 终态把百分比降级到悬停：终态全 100%，写出来只是重复。
                title: running
                  ? `${stageLabel(r.stage)} · ${tBound(`legendState_${state}`)} · ${pct}%`
                  : `${stageLabel(r.stage)} · ${fmtMs(dur ?? 0)}`,
              },
                el('i', { 'data-swatch': '' }),
                `${stepName(r.stage)} ${running ? `${pct}%` : fmtMs(dur ?? 0)}`)
            }))
        }
        const overallPct = (job) => {
          const idx = ACTIVE_STAGES.indexOf(stageOf(job))
          // partial 是所有阶段都跑完但完整性没成立：进度按 100 显示（活干完了），
          // 由终态标签「部分完成」+ 阻塞原因说明为什么没算完整成功。
          if (idx < 0) return (job.stage === 'done' || job.stage === 'partial') ? 100 : null
          let pct = 0
          for (const r of stageRows(job)) pct += (STAGE_WEIGHTS[r.stage] ?? 0) * r.frac
          return Math.min(99, Math.round(pct * 100))
        }
        // 并发池概览文案：平均进度 + 最慢任务的仓库名。取不到进度的一律不计入平均，
        // 避免一个刚排队的任务把整体读数拉成个位数。
        const poolSummary = (list) => {
          // 排队中的进度恒为 0，算进平均会让「最慢」永远是那个还没开始的仓库，
          // 读数反而失去意义——只统计真正在跑的任务，排队数单独报。
          const running = list.filter((j) => stageOf(j) !== 'queued').map((j) => ({ job: j, p: overallPct(j) })).filter((x) => x.p != null)
          const queuedCount = list.length - running.length
          if (!running.length) return tBound('poolAllQueued').replace('{n}', String(list.length))
          const avg = Math.round(running.reduce((s, x) => s + x.p, 0) / running.length)
          const slowest = running.reduce((m, x) => (x.p < m.p ? x : m))
          const queuedNote = queuedCount > 0 ? ` · ${tBound('poolQueued')} ${queuedCount}` : ''
          return `${avg}% · ${tBound('poolSlowest')} ${repoName(slowest.job.cwd)} ${slowest.p}%${queuedNote}`
        }
        // 吞吐徽标：实时通道显示 tok/s + spark；批量通道显示完成速率（篇/分，EWMA 平滑）+ ETA；
        // 批次尚无完成样本时显示排队/执行时长（batchSubmittedAt 起算）
        const throughputBadge = (job, sparkOf, rateOf) => {
          if (!ACTIVE_STAGES.includes(stageOf(job))) return null
          if (typeof job.tps === 'number' && job.tps > 0) {
            return el('span', { 'data-dscw-p-badge': '', 'data-tone': 'live' },
              `${job.tps >= 100 ? Math.round(job.tps) : job.tps.toFixed(1)} tok/s`,
              el(Spark, { values: sparkOf(job.id) }))
          }
          if (job.batchSubmittedAt) {
            const st = rateOf(job.id)
            const bp = job.batchProgress
            if (st?.rate > 0 && bp && bp.total > bp.completed) {
              const eta = (bp.total - bp.completed) / st.rate
              return el('span', { 'data-dscw-p-badge': '', 'data-tone': 'live' },
                `${st.rate >= 10 ? Math.round(st.rate) : st.rate.toFixed(1)} ${tBound('perMin')}`,
                ` · ${tBound('etaLabel')} ≈ ${eta >= 1 ? `${Math.ceil(eta)} min` : '<1 min'}`)
            }
            return el('span', { 'data-dscw-p-badge': '', 'data-tone': 'live' },
              `${tBound('batchRunLabel')} ${fmtMs(Date.now() - Date.parse(job.batchSubmittedAt))}`)
          }
          return null
        }
        // 用量行：输入为提交时估算，输出为响应实测；超单请求预算的请求数红字提示（按大档装填）
        const usageLine = (job) => {
          const u = job.usage
          if (!u || (!u.inputTok && !u.outputTok)) return null
          const inch = fmtTok(u.inputTok)
          const outch = fmtTok(u.outputTok)
          const bits = []
          if (inch || outch) bits.push(`${inch ? `${tBound('usageIn')} ${inch}` : ''}${inch && outch ? ' / ' : ''}${outch ? `${tBound('usageOut')} ${outch} tok` : ''}`)
          if (u.requests) {
            const ch = u.batchRequests && u.realtimeRequests
              ? ` (${tBound('batchChannel')} ${u.batchRequests} + ${tBound('realtimeChannel')} ${u.realtimeRequests})`
              : u.batchRequests ? ` (${tBound('batchChannel')} ${u.batchRequests})` : ''
            bits.push(`${tBound('reqLabel')} ${u.requests}${ch}`)
          }
          return el('span', { 'data-dscw-p-usage': '' },
            bits.join(' · '),
            u.overTier2 ? el('span', { 'data-warn': '' }, ` · ${u.overTier2} ${tBound('overTierLabel')}`) : null)
        }

        // 引擎日志块：阶段推进、桥请求、stderr、终止原因都在这里。
        // 只渲染内存里最近 40 条——完整文件可能上 MB，面板 2s 轮询不能碰它。
        const engineLogBlock = (job) => {
          const t = tBound
          const entries = Array.isArray(job.nativeLogs) ? job.nativeLogs : []
          if (!entries.length && !job.logError) return null
          const line = (e, i) => {
            const bits = [e.at ? String(e.at).slice(11, 19) : '--:--:--']
            if (e.phase) bits.push(`[${e.phase}]`)
            if (e.kind) bits.push(e.kind)
            if (e.detail) bits.push(String(e.detail))
            else if (e.method) bits.push(`${e.method} ${e.path ?? ''} ${e.status ?? ''} ${e.ms ?? ''}ms`)
            else if (e.text) bits.push(String(e.text).slice(0, 200))
            else if (e.message) bits.push(String(e.message).slice(0, 200))
            else if (e.reason) bits.push(String(e.reason))
            return el('div', { key: i, 'data-dscw-p-logline': '' }, bits.join(' '))
          }
          return el('details', { 'data-dscw-p-engine-log': '' },
            el('summary', null, `${t('engineLogLabel')} (${entries.length})`),
            job.logError ? el('div', { 'data-dscw-p-error': '' }, job.logError) : null,
            job.logFile ? el('div', { 'data-dscw-p-meta': '' }, `${t('engineLogFileLabel')}: ${job.logFile}`) : null,
            el('div', null, entries.map(line)))
        }

        // 总览标签页：所有工作区 wiki 的状态总览 + 自动更新调度信息（轮询 repos 端点）
        function ReposTab() {
          const t = tBound
          const [data, setData] = React.useState(null)
          const [err, setErr] = React.useState(null)
          const [busyCwd, setBusyCwd] = React.useState(null)
          const mountedRef = React.useRef(true)
          React.useEffect(() => () => { mountedRef.current = false }, [])

          const inFlightRef = React.useRef(false)
          const pull = async () => {
            if (inFlightRef.current) return
            inFlightRef.current = true
            try {
              const j = await apiGet(REPOS_PATH)
              if (mountedRef.current) { setData(j ?? {}); setErr(null) }
            } catch (e) {
              if (mountedRef.current) setErr(String(e?.message ?? e))
            } finally {
              inFlightRef.current = false
            }
          }
          React.useEffect(() => {
            pull()
            const id = setInterval(pull, REPOS_POLL_MS)
            return () => clearInterval(id)
          }, [])

          // 排除/取消排除：直接改插件配置 excludePaths（form.mutate，与设置卡保存同链路，
          // 经宿主 configForms 持久化并热生效）；成功后让服务端总览缓存失效并立即重拉
          const [exclBusy, setExclBusy] = React.useState(null)
          const toggleExclude = async (r) => {
            const snap = form?.getSnapshot?.()
            if (!snap || snap.status !== 'ready' || !snap.writable) return
            setExclBusy(r.cwd)
            try {
              const norm = (p) => String(p ?? '').replace(/[\\/]+$/, '').toLowerCase()
              const list = String(snap.value?.excludePaths ?? '').split(/[\n;，,]+/).map((x) => x.trim()).filter(Boolean)
              const has = list.some((p) => norm(p) === norm(r.cwd))
              const next = has ? list.filter((p) => norm(p) !== norm(r.cwd)) : [...list, r.cwd]
              const accepted = await form.mutate([{ op: 'set', path: ['excludePaths'], value: next.join('\n') }], snap.revision)
              if (accepted) {
                await apiPost(CONTROL_PATH, { action: 'refresh' }).catch(() => {})
                if (mountedRef.current) { setErr(null); await pull() }
              }
            } catch (e) {
              if (mountedRef.current) setErr(String(e?.message ?? e))
            }
            if (mountedRef.current) setExclBusy(null)
          }

          // 首次编译确认：只在仓库从没有过任何编译任务时出现（后端按 job 历史判），
          // 用户点下按钮才算同意为它生成 wiki；manual 编译按钮本来就是用户主动动作，
          // 所以第一次点确认之后就走普通编译路径，不会再来一次。
          const confirmCompile = async (cwd) => {
            setBusyCwd(cwd)
            try {
              await apiPost(CONTROL_PATH, { action: 'confirm', cwd })
            } catch (e) {
              if (mountedRef.current) setErr(String(e?.message ?? e))
            }
            if (mountedRef.current) setBusyCwd(null)
          }

          const compile = async (cwd) => {
            setBusyCwd(cwd)
            try {
              await apiPost(CONTROL_PATH, { action: 'compile', cwd })
            } catch (e) {
              if (mountedRef.current) setErr(String(e?.message ?? e))
            }
            if (mountedRef.current) setBusyCwd(null)
          }

          const sched = data?.scheduler
          const repos = Array.isArray(data?.repos) ? data.repos : []

          try {
            // 总览先回答三个问题，再给清单：
            // 「有多少仓要处理」「现在在跑什么」「谁在排队」——原来的页面直接从调度条跳到
            // 十个仓库的平铺列表，读者得自己数「有变更」才看得出总量，等于没有总览。
            const summary = (() => {
              const total = repos.length
              let stale = 0; let pending = 0; let clean = 0; let busy = 0
              for (const r of repos) {
                // 已排除的仓不参与任何一格的计数：它们既不用编译，也不该算进「干净」，
                // 否则「干净」会把人工排除的仓也算成已完成，读数偏高。
                if (r.excluded) continue
                if (r.needsConfirm) pending += 1
                else if (r.state === 'stale') stale += 1
                else if (r.state === 'clean') clean += 1
                const lj = r.lastJob
                if (lj && !['done', 'partial', 'failed', 'cancelled'].includes(lj.stage)) busy += 1
              }
              return { total, stale, pending, clean, busy }
            })()
            // 待办优先：需要人动手的（待确认 / 有变更）排前面，「干净的」沉底。
            // 平铺按插入序时，刚加入的新仓库会插到中间，每天最该点的几行被推来推去。
            const rankOf = (r) => (r.excluded ? 5 : r.state === 'error' ? 4 : r.needsConfirm ? 0 : r.state === 'stale' ? 1 : r.state === 'clean' ? 3 : 2)
            const sorted = [...repos].sort((a, b) => rankOf(a) - rankOf(b) || Number(Boolean(b.lastJob)) - Number(Boolean(a.lastJob)))
            return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              // 统计条五格：比一句「扫到 N 仓」更能一眼看出该不该动手。
              // 只报「要处理的」和「在跑的」，「已排除 / 出错」不进格——它们是清单里的个别行，
              // 摆进汇总会让人以为有整批问题。
              el('div', { 'data-dscw-p-stats': '' },
                el('div', { 'data-dscw-p-stat': '', 'data-tone': summary.pending ? 'warn' : 'plain' },
                  el('b', null, String(summary.pending)),
                  el('span', null, t('overviewPending'))),
                el('div', { 'data-dscw-p-stat': '', 'data-tone': summary.stale ? 'warn' : 'plain' },
                  el('b', null, String(summary.stale)),
                  el('span', null, t('overviewStale'))),
                el('div', { 'data-dscw-p-stat': '', 'data-tone': summary.busy ? 'ok' : 'plain' },
                  el('b', null, String(summary.busy)),
                  el('span', null, t('overviewBusy'))),
                el('div', { 'data-dscw-p-stat': '', 'data-tone': 'plain' },
                  el('b', null, String(summary.clean)),
                  el('span', null, t('overviewClean'))),
                el('div', { 'data-dscw-p-stat': '', 'data-tone': 'plain' },
                  el('b', null, String(summary.total)),
                  el('span', null, t('overviewTotal'))),
              ),
              el('div', { 'data-dscw-p-sched': '' },
                el('div', { 'data-dscw-p-row': '' },
                  el('span', null, t('schedTitle')),
                  el(Tag, null, sched ? (sched.enabled ? t('schedOn') : t('schedOff')) : '—'),
                  sched ? `${t('schedEvery')} ${sched.intervalMin} ${t('schedMinutes')}` : null,
                  sched?.scanning ? el('span', { 'data-dscw-p-stage': '', 'data-running': 'true' }, t('schedScanning')) : null,
                ),
                el('div', { 'data-dscw-p-meta': '' },
                  `${t('schedLast')}: ${sched?.lastScan ? new Date(sched.lastScan).toLocaleString() : t('schedNever')}`,
                  sched?.lastError ? ` · ${sched.lastError}` : '',
                ),
                sched?.enabled && sched?.lastScan
                  ? (() => {
                    // 下次扫描 = 上次扫描 + 间隔（60s 心跳有同量级误差，显示为约值）
                    const next = Date.parse(sched.lastScan) + (sched.intervalMin ?? 0) * 60000
                    const remain = next - Date.now()
                    const stats = sched.lastScanRepos != null
                      ? ` · ${t('scannedLabel')} ${sched.lastScanRepos} · ${t('submittedLabel')} ${sched.lastScanSubmitted ?? 0}`
                        + (sched.lastScanSkipped ? ` · ${t('skippedLabel')} ${sched.lastScanSkipped}` : '')
                        + (sched.lastScanPending ? ` · ${t('pendingLabel')} ${sched.lastScanPending}` : '')
                      : ''
                    return el('div', { 'data-dscw-p-meta': '' },
                      `${t('nextScan')}: ${sched.scanning
                        ? t('schedScanning')
                        : remain > 0
                          ? `${new Date(next).toLocaleTimeString()}（≈ ${fmtDur(remain)}）`
                          : '—'}${stats}`)
                  })()
                  : null,
              ),
              err ? el('div', { 'data-dscw-p-empty': '' }, err) : null,
              sorted.length
                ? el('div', { 'data-dscw-p-repolist': '' }, sorted.map((r) => {
                  const st = String(r.state ?? 'error')
                  const stState = st === 'clean' ? 'done' : st === 'stale' ? 'stale' : st === 'error' ? 'failed' : 'cancelled'
                  return el('div', { key: r.cwd, 'data-dscw-p-repo': '', 'data-rank': rankOf(r) },
                    el('div', { 'data-dscw-p-row': '' },
                      el('span', { style: { fontWeight: 500 }, title: r.cwd }, repoName(r.cwd)),
                      r.excluded ? el(Tag, null, t('excludedTag')) : null,
                      r.needsConfirm && !r.excluded ? el(Tag, null, t('needConfirmTag')) : null,
                      el('span', { 'data-dscw-p-stage': '', 'data-state': stState }, stateLabel(st)),
                      r.needsConfirm && !r.excluded
                        ? el(Button, {
                          variant: 'ghost', size: 'sm',
                          onClick: () => confirmCompile(r.cwd), disabled: busyCwd === r.cwd,
                        }, t('confirmCompile'))
                        : null,
                      st === 'stale' && !r.needsConfirm
                        ? el(Button, {
                          variant: 'ghost', size: 'sm',
                          onClick: () => compile(r.cwd), disabled: busyCwd === r.cwd,
                        }, t('compileNow'))
                        : null,
                      el(Button, {
                        variant: 'ghost', size: 'sm',
                        disabled: exclBusy === r.cwd,
                        onClick: () => toggleExclude(r),
                      }, r.excluded ? t('unexcludeRepo') : t('excludeRepo')),
                    ),
                    (() => {
                      const lj = r.lastJob
                      // partial 也是终态（不再推进），否则会把已结束的任务当成「在跑」继续显示进度条
                      const ljActive = lj && !['done', 'partial', 'failed', 'cancelled'].includes(lj.stage)
                      const tl = ljActive && Array.isArray(lj.taskList) ? lj.taskList : []
                      const tlDone = tl.filter((x) => x.state === 'done').length
                      const barDone = ljActive && lj.batchProgress ? lj.batchProgress.completed : tlDone
                      const barTotal = ljActive && lj.batchProgress ? Math.max(lj.batchProgress.total, tl.length) : tl.length
                      const parts = []
                      if (st === 'stale') parts.push(`${t('stateStale')} ${r.staleArticles ?? 0} ${t('unitArticle')} · ${t('changedLabel')} ${r.changedFiles ?? 0}`)
                      if (r.articleCount) parts.push(`${r.articleCount} ${t('unitArticle')}`)
                      if (lj) {
                        parts.push(`${kindLabelOf(t, lj.kind)} · ${stageLabel(lj.stage)}${lj.auto ? ` · ${t('autoTag')}` : ''}`)
                        if (!ljActive && lj.finishedAt) parts.push(`${t('lastCompile')} ${fmtAgo(lj.finishedAt)}`)
                      }
                      if (ljActive && lj.batchProgress) parts.push(`${t('batchLabel')} ${lj.batchProgress.completed}/${lj.batchProgress.total}`)
                      if (ljActive && lj.tps) parts.push(`tps ${lj.tps}`)
                      return el(React.Fragment, null,
                        r.needsConfirm && !r.excluded
                          ? el('div', { 'data-dscw-p-meta': '' }, t('confirmHint'))
                          : null,
                        parts.length ? el('div', { 'data-dscw-p-meta': '' }, parts.join(' · ')) : null,
                        barTotal > 0 ? progressBar(barDone, barTotal) : null,
                      )
                    })(),
                  )
                }))
                : el('div', { 'data-dscw-p-empty': '' },
                  el('strong', null, t('emptyReposTitle')),
                  el('span', null, t('reposEmpty'))),
            )
          } catch (e) {
            return el('div', { 'data-dscw-p-empty': '' }, `Repos error: ${String(e?.stack ?? e)}`)
          }
        }

        // 会话视图（1.1.0 单任务 / 1.2.0 全局）：并发池的每一次 LLM 请求，像给 codewiki
        // 专门开的会话。列表 5s 轮询（running 请求实时涨 outputChars），点开看 prompt/输出
        // 全文；保留 24h。job 为 null 时走全局聚合接口（不带 jobId），跨任务列出全部请求，
        // 行里带上「哪个任务 + 哪个仓库」；选中后仍按 (jobId, n) 拉单条全文。
        // embedded=true 表示被塞进面板 tab（外层已经是滚动容器）：此时不能再套一层
        // [data-dscw-p-page]——那会得到双层 padding + 双层 height:100% + 双层滚动条，
        // 会话列表被压进一条窄缝里滚，看起来就像「会话标签页不能用」。
        function SessionView({ job, onClose, embedded = false }) {
          const t = tBound
          const global = !job
          const [list, setList] = React.useState(null)
          const [activeJobs, setActiveJobs] = React.useState([])
          const [err, setErr] = React.useState(null)
          const [sel, setSel] = React.useState(null) // 选中的请求 { jobId, n }
          const [item, setItem] = React.useState(null)
          React.useEffect(() => {
            let alive = true
            let inFlight = false
            const pull = async () => {
              if (inFlight) return
              inFlight = true
              try {
                const d = await apiGet(global ? SESSIONS_PATH : `${SESSIONS_PATH}?jobId=${encodeURIComponent(job.id)}`)
                if (alive) { setList(Array.isArray(d.sessions) ? d.sessions : []); setActiveJobs(Array.isArray(d.active) ? d.active : []); setErr(null) }
              } catch (e) {
                if (alive) setErr(String(e?.message ?? e))
              } finally {
                inFlight = false
              }
            }
            pull()
            const id = setInterval(pull, 5000)
            return () => { alive = false; clearInterval(id) }
          }, [job?.id, global])
          React.useEffect(() => {
            if (!sel) { setItem(null); return }
            let alive = true
            apiGet(`${SESSIONS_ITEM_PATH}?jobId=${encodeURIComponent(sel.jobId)}&n=${sel.n}`)
              .then((d) => { if (alive) setItem(d) })
              .catch((e) => { if (alive) setItem({ error: String(e?.message ?? e) }) })
            return () => { alive = false }
          }, [sel?.jobId, sel?.n])
          const close = () => { setSel(null); onClose() }
          const jobTag = (id) => String(id ?? '').replace(/^job-/, '')
          return el('div', {
            // 嵌进 tab 时不套 page 容器（外层已是滚动容器），改用无内边距的 sesswrap
            ...(embedded ? { 'data-dscw-p-sesswrap': '' } : { 'data-dscw-p-page': '' }),
          },
            // 嵌进 tab 时面板已有标题栏，这里只留必要的返回/关闭，不再重复一个大标题
            embedded ? null : el('div', { 'data-dscw-p-head': '' },
              el('h3', null, global ? t('sessGlobalTitle') : t('sessTitle')),
              sel ? el(Button, { variant: 'ghost', size: 'sm', onClick: () => setSel(null) }, t('sessBack')) : null,
              el(Button, { variant: 'ghost', size: 'sm', onClick: close }, '✕'),
            ),
            embedded
              ? el('div', { 'data-dscw-p-sessbar': '' },
                el('span', null, global ? t('sessGlobalTitle') : t('sessTitle')),
                sel ? el(Button, { variant: 'ghost', size: 'sm', onClick: () => setSel(null) }, t('sessBack')) : null,
              )
              : null,
            global
              ? el('div', { 'data-dscw-p-meta': '' }, t('sessGlobalHint'))
              : el('div', { 'data-dscw-p-meta': '', title: job.cwd ?? job.id }, `${job.id}`),
            sel
              ? el('div', { 'data-dscw-p-sessitem': '' },
                (() => {
                  const meta = (list ?? []).find((x) => x.n === sel.n && (x.jobId ?? job?.id) === sel.jobId)
                  const bits = [meta?.name, meta?.model, meta?.status, meta?.startedAt]
                  return el('div', { 'data-dscw-p-meta': '' }, bits.filter(Boolean).join(' · '))
                })(),
                item == null
                  ? el(Skeleton)
                  : item.error
                    ? el('div', { 'data-dscw-p-error': '' }, item.error)
                    : el(React.Fragment, null,
                      el('details', { 'data-dscw-p-sessbody': '' },
                        el('summary', null, t('sessPrompt')),
                        el('pre', null, item.prompt ?? '')),
                      el('div', { 'data-dscw-p-sessbody': '' },
                        el('div', { 'data-dscw-p-meta': '' }, t('sessOutput')),
                        el('pre', null, item.output || '…'),
                      ),
                    ),
              )
              : err
                ? el('div', { 'data-dscw-p-empty': '' }, err)
                : list === null
                  ? el(Skeleton)
                  : el(React.Fragment, null,
                    // 进行中任务（0.17.5）：会话记录只在发出过 LLM 请求后才存在，
                    // 正在跑依赖图/聚类/收尾、或本轮无需写文章的任务原本在会话页完全不可见。
                    activeJobs.length
                      ? el('div', { 'data-dscw-p-active': '' },
                        el('div', { 'data-dscw-p-meta': '' }, `${t('sessActiveTitle')} (${activeJobs.length})`),
                        activeJobs.map((a) => el('div', {
                          key: `active-${a.jobId}`, 'data-dscw-p-activerow': '', 'data-stage': a.stage,
                        },
                          el('span', { 'data-mark': '' }, '▸'),
                          el('span', { 'data-name': '', title: a.cwd || a.jobId }, global ? jobTag(a.jobId) : (a.cwd || a.jobId)),
                          el('span', { 'data-sub': '' }, [
                            `${t('sessActiveStage')} ${a.stage}`,
                            nativeStageName(a.nativeStage),
                            a.nativeStage && Number.isFinite(a.nativePercent) ? `${a.nativePercent}%` : null,
                            a.batchProgress ? `${a.batchProgress.completed}/${a.batchProgress.total}` : null,
                            a.writtenCount ? t('sessActiveWritten').replace('{n}', a.writtenCount) : null,
                            global && a.cwd ? String(a.cwd).split(/[\/]/).filter(Boolean).pop() : null,
                            a.requests > 0 ? t('sessActiveRequests').replace('{n}', a.requests) : t('sessActiveNoRequest'),
                          ].filter(Boolean).join(' · ')),
                        )),
                      )
                      : null,
                    !list.length
                      ? (activeJobs.length ? null : el('div', { 'data-dscw-p-empty': '' },
                        el('strong', null, t('emptySessionsTitle')),
                        el('span', null, t('sessEmpty'))))
                      : (() => {
                        // 按工作区分组：全局会话里几十条请求分属十几个仓库，平铺时
                        // 「这条属于哪个仓」只能靠每行尾部那个目录名字去认，滚动时完全丢失上下文。
                        // 单任务视图只有一个仓，不需要分组容器（否则多一层无用嵌套）。
                        const cwdOf = (s) => String(s.cwd ?? job?.cwd ?? '')
                        const groups = new Map()
                        for (const s of list) {
                          const k = cwdOf(s)
                          if (!groups.has(k)) groups.set(k, [])
                          groups.get(k).push(s)
                        }
                        // 组顺序按组内最新一条的时间倒序：刚活动过的仓排最前
                        const ordered = [...groups.entries()].sort((a, b) => {
                          const ta = String(a[1][0]?.startedAt ?? '')
                          const tb = String(b[1][0]?.startedAt ?? '')
                          return tb.localeCompare(ta)
                        })
                        const rows = (items) => el('div', { 'data-dscw-p-sesslist': '' }, items.map((s) => el('button', {
                          key: `${s.jobId ?? job?.id}#${s.n}`, 'data-dscw-p-sessrow': '', 'data-status': s.status,
                          onClick: () => setSel({ jobId: s.jobId ?? job?.id, n: s.n }),
                        },
                          el('span', { 'data-mark': '' }, s.status === 'running' ? '▸' : s.status === 'done' ? '✓' : '✗'),
                          el('span', { 'data-name': '', title: s.name }, `#${s.n} ${s.name}`),
                          el('span', { 'data-sub': '' }, [
                            s.status === 'running' ? t('sessRunning') : null,
                            global ? jobTag(s.jobId) : null,
                            s.model,
                            s.outputChars ? `~${Math.round(s.outputChars / 1000)}k ch` : null,
                            s.inputTokens ? `in ${Math.round(s.inputTokens / 1000)}k tok` : null,
                            s.startedAt ? new Date(s.startedAt).toLocaleTimeString() : null,
                          ].filter(Boolean).join(' · ')),
                        )))
                        if (!global) return rows(list)
                        return el('div', { 'data-dscw-p-sessgroups': '' }, ordered.map(([cwd, items], gi) => el('details', {
                          key: cwd || '__none', 'data-dscw-p-sessgroup': '', open: gi === 0,
                        },
                          el('summary', null,
                            el('span', { 'data-repo': '', title: cwd }, cwd ? repoName(cwd) : t('sessNoCwd')),
                            el('span', { 'data-count': '' }, t('sessGroupCount').replace('{n}', items.length))),
                          rows(items),
                        )))
                      })(),
                  ),
          )
        }

        function CodewikiPanel() {
          const t = tBound
          const [jobs, setJobs] = React.useState(null) // null = 尚未拿到首轮
          const [err, setErr] = React.useState(null)
          const [busyId, setBusyId] = React.useState(null)
          const [tab, setTab] = React.useState('overview')
          const [sessJob, setSessJobState] = React.useState(null) // 打开会话视图的任务
          // 单任务会话视图（任务行「会话」按钮）会占满整页；全局「会话」Tab（1.2.0）则留在
          // Tab 页内渲染，页面顶部的 Tab 条保持可见，随时能切走。
          const setSessJob = (j) => { setSessJobState(j); if (j) setTab('tasks') }
          const [copiedPath, setCopiedPath] = React.useState(null)
          // 面板侧采样（2s 轮询差分）：tps 滚动窗口画 spark；批量完成速率 EWMA 算吞吐与 ETA
          const sparkRef = React.useRef(new Map()) // jobId -> number[]
          const batchRateRef = React.useRef(new Map()) // jobId -> { at, completed, rate }
          const sparkOf = (id) => sparkRef.current.get(id) ?? []
          // 进度趋势（0.17.35）：每轮记一次 overallPct。只看数字不知道「还剩多久」，
          // 看斜率才知道：曲线平了说明卡住，还在涨说明在推进。
          const pctTrendRef = React.useRef(new Map()) // jobId -> number[]
          const trendOf = (id) => pctTrendRef.current.get(id) ?? []
          const rateOf = (id) => batchRateRef.current.get(id) ?? null

          React.useEffect(() => {
            let alive = true
            let inFlight = false
            const pull = async () => {
              if (inFlight) return // 上次请求未回包（服务卡顿）时不重叠拉取
              inFlight = true
              try {
                const data = await apiGet(JOBS_PATH)
                if (!alive) return
                const arr = Array.isArray(data.jobs) ? data.jobs : []
                const now = Date.now()
                for (const j of arr) {
                const pj = overallPct(j)
                if (pj != null) {
                  const h2 = pctTrendRef.current.get(j.id) ?? []
                  if (h2[h2.length - 1] !== pj) h2.push(pj)
                  if (h2.length > 24) h2.shift()
                  pctTrendRef.current.set(j.id, h2)
                }
                  if (typeof j.tps === 'number' && j.tps > 0) {
                    const h = sparkRef.current.get(j.id) ?? []
                    h.push(j.tps)
                    if (h.length > 30) h.shift()
                    sparkRef.current.set(j.id, h)
                  }
                  const b = j.batchProgress
                  if (j.batchSubmittedAt && b && typeof b.completed === 'number') {
                    const prev = batchRateRef.current.get(j.id)
                    if (!prev) batchRateRef.current.set(j.id, { at: now, completed: b.completed, rate: null })
                    else if (b.completed > prev.completed && now > prev.at) {
                      const inst = (b.completed - prev.completed) / ((now - prev.at) / 60000)
                      const rate = prev.rate == null ? inst : prev.rate * 0.6 + inst * 0.4
                      batchRateRef.current.set(j.id, { at: now, completed: b.completed, rate })
                    } else batchRateRef.current.set(j.id, { ...prev, completed: b.completed })
                  } else batchRateRef.current.delete(j.id)
                }
                setJobs(arr)
                setErr(null)
              } catch (e) {
                if (alive) setErr(String(e?.message ?? e))
              } finally {
                inFlight = false
              }
            }
            pull()
            const id = setInterval(pull, POLL_MS)
            return () => { alive = false; clearInterval(id) }
          }, [])

          // 卸载后不再 setState（轮询 fetch 可能晚于组件卸载回包）
          const mountedRef = React.useRef(true)
          React.useEffect(() => () => { mountedRef.current = false }, [])
          const cancel = async (jobId) => {
            setBusyId(jobId)
            try {
              await apiPost(CONTROL_PATH, { action: 'cancel', jobId })
            } catch (e) {
              if (mountedRef.current) setErr(String(e?.message ?? e))
            }
            if (mountedRef.current) setBusyId(null)
          }
          const copyPath = async (p) => {
            try {
              await navigator.clipboard.writeText(p)
              setCopiedPath(p)
              setTimeout(() => { setCopiedPath((cur) => (cur === p ? null : cur)) }, 1500)
            } catch { /* 剪贴板权限拒绝时静默 */ }
          }

          const kindLabel = (kind) => (t(`kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}`))

          const isActive = (job) => ACTIVE_STAGES.includes(stageOf(job))

          // 按工作区（cwd）分组；保持首次出现顺序，组内最新在前（服务历史折叠区）
          const groups = []
          const byCwd = new Map()
          for (const job of jobs ?? []) {
            let g = byCwd.get(job.cwd)
            if (!g) { g = []; byCwd.set(job.cwd, g); groups.push({ cwd: job.cwd, jobs: g }) }
            g.unshift(job)
          }

          // 进行中任务全部展开（并发上限 3，同时跑多个是常态）；没有进行中的时候
          // 只留最近更新的一个当门面，其余收进「历史任务」折叠区。
          const byUpdated = (a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? ''))
          const all = jobs ?? []
          const actives = all.filter(isActive).sort(byUpdated)
          const shown = actives.length ? actives : (all.length ? [[...all].sort(byUpdated)[0]].flat() : [])
          const rest = all.filter((j) => !shown.includes(j))
          const hasRunning = actives.length > 0

          const jobCard = (job, showCwd = false) => {
            const active = isActive(job)
            const arts = Array.isArray(job.articles) ? job.articles : []
            const okCount = arts.filter((a) => a.ok).length
            const taskList = Array.isArray(job.taskList) ? job.taskList : []
            const total = taskList.length || arts.length
            const meta = []
            if (total) meta.push(`${t('writtenLabel')} ${okCount}/${total} ${t('unitArticle')}`)
            else if (typeof job.writtenCount === 'number') meta.push(`${t('writtenLabel')} ${job.writtenCount} ${t('unitArticle')}`)
            if (job.failedCount) meta.push(`${t('failedLabel')} ${job.failedCount}`)
            // 原生通道（阶段 4）：步骤条是粗粒度六步，引擎自报的是八段契约——粒度不同，
            // 所以真实引擎阶段另起一项显示，不能拿它去改步骤条的序号（那会让旧任务错位）。
            if (job.channel === 'native') {
              const ns = nativeStageName(job.nativeStage)
              if (active && ns) meta.push(`${t('nativeStageLabel')} ${ns}${Number.isFinite(job.nativePercent) ? ` ${job.nativePercent}%` : ''}`)
              const nr = job.nativeResult
              if (!active && nr?.gate?.outcome) meta.push(`${t('gateLabel')} ${nr.gate.outcome}`)
              if (!active && nr?.apply?.outcome) meta.push(`${t('applyLabel')} ${nr.apply.outcome}`)
            }
            const blockers = Array.isArray(job.blockers) ? job.blockers : []
            if (active && job.batchProgress) meta.push(`${t('batchLabel')} ${job.batchProgress.completed}/${job.batchProgress.total}`)
            // 已用时拆「排队 / 执行」：排队时长来自 stageTimings.queued（正在排队时实时算），
            // 执行 = 总时长 − 排队。不再让 2 小时排队被看成「编译跑了 2 小时」。
            const elapsedSplit = (j, endNow) => {
              const q = j.stageTimings?.queued ?? (j.stage === 'queued' ? endNow - Date.parse(j.createdAt) : 0)
              const total = (j.finishedAt ? Date.parse(j.finishedAt) : endNow) - Date.parse(j.createdAt)
              return { q: Math.max(0, q), run: Math.max(0, total - Math.max(0, q)) }
            }
            if (active && job.createdAt) {
              const { q, run } = elapsedSplit(job, Date.now())
              if (job.stage === 'queued') meta.push(`${t('elapsedLabel')} ${fmtMs(q)}（${t('queueWaitLabel')}）`)
              else meta.push(`${t('elapsedLabel')} ${fmtMs(q + run)}（${t('queueWaitLabel')} ${fmtMs(q)} · ${t('runTimeLabel')} ${fmtMs(run)}）`)
            } else if (job.finishedAt && job.createdAt) {
              const { q, run } = elapsedSplit(job, Date.now())
              meta.push(`${t('totalTimeLabel')} ${fmtMs(q + run)}（${t('queueWaitLabel')} ${fmtMs(q)} · ${t('runTimeLabel')} ${fmtMs(run)}）`)
            }
            // 自动提交结果（0.10.9）：成功显示短 sha，无改动/失败各一句。
            // 0.10.10：失败原因（可能是 git stderr 摘录，几十字）放进任务行 title，
            // 不塞进 meta——否则一行 meta 被原因撑爆，把阶段/用时挤出可视区。
            let acTitle = null
            if (!active && job.autoCommit) {
              const ac = job.autoCommit
              if (ac.committed) meta.push(`${t('autoCommitOk')} ${ac.sha ?? ''}${ac.branch ? ` · ${ac.branch}` : ''}`.trim())
              else if (ac.noChanges) meta.push(t('autoCommitNone'))
              else {
                meta.push(t('autoCommitPending'))
                if (ac.reason) acTitle = `${t('autoCommitPending')}：${ac.reason}`
              }
            }
            // 完整性终态（0.14.0）：partial 表示「写成了部分文章，但有变化没被消化」，
            // 把首个阻塞原因直接放进任务行——只说「部分完成」而不说为什么等于没说。
            // 阻塞原因是几十字的中文句子，塞进 meta 会撑爆一行，所以放 title 悬停看。
            let blockTitle = null
            if (!active && job.stage === 'partial' && blockers.length) {
              meta.push(`未消化 ${blockers.length} 项`)
              blockTitle = blockers.slice(0, 3).map((b) => String(b.detail ?? b.kind)).join('；')
            }
            const jobTitle = [acTitle, blockTitle].filter(Boolean).join('\n') || undefined
            const pct = overallPct(job)
            const curStep = stageOf(job)
            const ns = job.channel === 'native' && active ? nativeStageName(job.nativeStage) : null
            const liveMs = active && job.stageStartedAt ? Date.now() - Date.parse(job.stageStartedAt) : null
            // 备注只常显最新一条，历史进折叠；折叠里排除这一条，避免同一句话出现两次。
            const noteList = Array.isArray(job.notes) ? job.notes : []
            const lastNote = noteList.length ? String(noteList[noteList.length - 1]) : null
            const activityNotes = noteList.slice(0, -1)
            const headMeta = []
            if (active) headMeta.push(`${stepName(curStep)}${liveMs != null ? ` ${fmtMs(liveMs)}` : ''}`)
            if (ns) headMeta.push(`${ns}${Number.isFinite(job.nativePercent) ? ` ${job.nativePercent}%` : ''}`)
            return el('div', {
              key: job.id, 'data-dscw-p-job': '',
              'data-active': active ? 'true' : null,
              'data-tone': job.stage,
              title: jobTitle,
            },
              el('div', { 'data-dscw-p-row': '' },
                el(Tag, null, kindLabel(job.kind)),
                // 进行中的卡片在顶部独立成区、没有分组头标目录，所以自己报一次归属；
                // 历史卡在分组头里已经有目录名，不重复。
                showCwd && job.cwd
                  ? el('span', { 'data-dscw-p-cwd': '', title: job.cwd }, repoName(job.cwd))
                  : null,
                el('span', {
                  'data-dscw-p-stage': '', 'data-state': job.stage,
                  'data-running': active ? 'true' : null,
                }, stageLabel(job.stage)),
                el('div', { 'data-dscw-p-actions': '' },
                  throughputBadge(job, sparkOf, rateOf),
                  el(Button, {
                    variant: 'ghost', size: 'sm',
                    onClick: () => setSessJob({ id: job.id, cwd: job.cwd }),
                  }, t('sessBtn')),
                  active
                    ? el(Button, {
                      variant: 'ghost', size: 'sm',
                      onClick: () => cancel(job.id),
                      disabled: busyId === job.id || job.cancelRequested === true,
                    }, job.cancelRequested === true ? t('cancelRequestedLabel') : t('cancelJob'))
                    : null),
              ),
              // 进度一行放完：大数字 · 进度条 · 当前阶段说明。早先数字块和进度条各占一行，
              // 加上七行轨道，一张卡能吃掉半屏——信息量没变，高度翻了四倍。
              // 0.17.46 起只有一条进度条：分段带就是它。段宽=该阶段时间占比，色相=阶段身份。
              // 阶段身份用颜色表达，完成度用填充宽度表达，互不抢占同一通道。
              // 失败/取消的任务总进度是 null，但「时间花在哪一步」恰恰是它们最该看的，
              // 所以这一行在 pct 为 null 时只要还有耗时数据就照画，只是不报百分比数字。
              (pct == null && !(!active && hasTimings(job)))
                ? null
                : el('div', { 'data-dscw-p-progress': '' },
                  pct == null
                    ? null
                    : el('div', { 'data-dscw-p-pct': '' }, String(pct), el('span', { 'data-unit': '' }, '%')),
                  // 一条条子的两种画法：有分段信息就用分段带，老任务（没有 stageTimings、
                  // 也没进到可计时的阶段）退回纯色填充，免得整行空着。
                  (active && pct > 0) || (!active && hasTimings(job))
                    ? stageSegments(job, active)
                    : el('div', { 'data-dscw-p-bar': '', 'data-tone': job.stage },
                      el('div', { 'data-dscw-p-barfill': '', style: { width: `${pct ?? 0}%` } })),
                  // 趋势：数字告诉你在哪，斜率告诉你还动不动。
                  trendOf(job.id).length > 1
                    ? el('span', { 'data-dscw-p-trend': '', title: t('trendHint') }, el(Spark, { values: trendOf(job.id), width: 48, height: 14 }))
                    : null,
                  headMeta.length
                    ? el('span', { 'data-dscw-p-pctmeta': '' }, headMeta.join(' · '))
                    : null),
              // 图例解释分段带上的颜色与读数：进行中读百分比，终态读耗时。
              (active && pct > 0) || (!active && hasTimings(job))
                ? stageLegend(job, active)
                : null,
              // 次要信息压成一条流水线：数字、用量、最新一条备注合成一行，放不下就换行。
              // 各占一行时，光这些「补充说明」就能吃掉 80px，而它们没有一条比进度更该先看。
              (meta.length || job.usage || lastNote)
                ? el('div', { 'data-dscw-p-subline': '' },
                  meta.length ? el('span', null, meta.join(' · ')) : null,
                  usageLine(job),
                  lastNote
                    ? el('span', { 'data-dscw-p-note': '', title: lastNote }, lastNote)
                    : null)
                : null,
              // 排队可见性：在等谁（正在跑的 + 排在前面的 queued），服务端 jobs 端点注入
              job.stage === 'queued' && Array.isArray(job.queueAhead) && job.queueAhead.length
                ? el('div', { 'data-dscw-p-queueahead': '' },
                  `${t('queueAheadLabel')}：${job.queueAhead.join(' → ')}`)
                : null,
              // 逐篇清单与活动流都收进折叠：几十篇文章平铺就是几十行，它们要看但不该常驻。
              // 活动流排除最后一条——它已经在上面那行显示过了，重复列一遍等于白占一行。
              activityNotes.length
                ? el('details', { 'data-dscw-p-activity': '' },
                  // 计数用实际展开的条数：折叠里少了一条（最新那条已在上面常显），
                  // 写总数会让「点开数了少一条」变成疑点。
                  el('summary', { title: t('activityHint') }, `${t('activityLabel')} (${activityNotes.length}/${job.notes.length})`),
                  el('div', { 'data-body': '' },
                    activityNotes.map((n, i) => {
                      // 每条活动拆成「状态点 + 阶段标签 + 正文」三件：整段文字堆在一起时，
                      // 「哪条是警告、属于哪个阶段、先后顺序如何」全得逐字读才看得出来。
                      const row = activityRow(n)
                      return el('div', { key: i, 'data-dscw-p-actrow': '', 'data-tone': row.tone },
                        el('span', { 'data-dot': '' }),
                        row.stage ? el('span', { 'data-stage': '' }, row.stage) : null,
                        el('span', { 'data-text': '' }, row.text))
                    })))
                : null,
              // 引擎日志（0.17.1）：此前 job.nativeLogs 既不进 jobSummary 也不渲染，
              // 一次 99 分钟的编译在界面上完全不可解释。这里给出「最近 40 条」的
              // 可展开视图，完整 NDJSON 引导到端点，避免把面板轮询变成大文件下载。
              engineLogBlock(job),
              job.error ? el('div', { 'data-dscw-p-error': '' }, job.error) : null,
              active && taskList.length
                ? el('details', { 'data-dscw-p-tasklist': '' },
                  el('summary', null, `${t('taskListLabel')} (${okCount}/${total})`),
                  el('div', { 'data-body': '' },
                    taskList.map((x) => el('div', { key: x.name, 'data-dscw-p-task': '', 'data-state': x.state },
                      el('span', { 'data-mark': '' }, x.state === 'done' ? '✓' : x.state === 'failed' ? '✗' : '·'),
                      el('span', null, x.name)))))
                : null,
              job.wikiPath
                ? el('div', { 'data-dscw-p-meta': '', style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  el('span', {
                    style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    title: job.wikiPath,
                  }, `${t('wikiAt')}${job.wikiPath}`),
                  el(Button, { variant: 'ghost', size: 'sm', onClick: () => copyPath(job.wikiPath) },
                    copiedPath === job.wikiPath ? t('copiedLabel') : t('copyPath')))
                : null,
            )
          }

          try {
            return el('div', { 'data-dscw-p-page': '' },
              sessJob
                ? el(SessionView, { job: sessJob, onClose: () => setSessJobState(null) })
                : el(React.Fragment, null,
              el('div', { 'data-dscw-p-head': '' },
                el('h3', null, t('panelTitle')),
                (jobs ?? []).filter(isActive).length
                  ? el(Tag, null, `${(jobs ?? []).filter(isActive).length} ${t('runningCount')}`)
                  : null,
              ),
              el('div', { 'data-dscw-p-tabs': '' },
                [['overview', t('tabOverview')], ['tasks', t('tabTasks')], ['sessions', t('tabSessions')], ['settings', t('tabSettings')]].map(([id, label]) =>
                  el('button', {
                    key: id, 'data-dscw-p-tab': '',
                    'data-on': tab === id ? 'true' : null,
                    onClick: () => setTab(id),
                  }, label)),
              ),
              tab === 'overview' ? el(ReposTab) : null,
              // 全局会话（1.2.0）：跨任务列出并发池全部 LLM 请求；job=null 走聚合接口。
              // embedded=true：面板本身已是滚动容器，会话视图别再套一层 page 布局。
              tab === 'sessions' ? el(SessionView, { job: null, embedded: true, onClose: () => setTab('overview') }) : null,
              tab === 'settings' ? el('div', { 'data-dscw-p-settings': '' }, el(CodewikiCard)) : null,
              tab === 'tasks'
                ? (err ? el('div', { 'data-dscw-p-empty': '' }, err)
                  : jobs === null
                    ? el(Skeleton)
                    : !all.length
                      ? el('div', { 'data-dscw-p-empty': '' },
                        el('strong', null, t('emptyTasksTitle')),
                        el('span', null, t('panelEmpty')))
                      : el(React.Fragment, null,
                        hasRunning
                          ? el(React.Fragment, null,
                            el('div', { 'data-dscw-p-seclabel': '' },
                              el('span', null, `${t('runningLabel')} (${actives.length})`),
                              // 并发总览：多个任务同时跑时，逐个看卡片拼不出整体节奏。
                              // 这里给平均进度与最慢的那个，一眼判断「是不是有任务在拖后腿」。
                              actives.length > 1
                                ? el('span', { 'data-dscw-p-pool': '', title: t('poolHint') }, poolSummary(actives))
                                : null),
                            el('div', { 'data-dscw-p-jobs': '' }, actives.map((j) => jobCard(j, true))))
                          : (shown.length ? jobCard(shown[0], true) : null),
                        rest.length
                          ? el('details', { 'data-dscw-p-history': '' },
                            el('summary', null, `${t('historyLabel')} (${rest.length})`),
                            el('div', { 'data-dscw-p-groups': '' },
                              groups.map((g) => {
                                const gj = g.jobs.filter((j) => !shown.includes(j))
                                if (!gj.length) return null
                                // 一个仓库一个折叠：并发跑多个仓库时，历史区最长的就是同一仓库的
                                // 几十轮，平铺会把别的仓库彻底挤出视野。默认收起，展开才看每一轮。
                                return el('details', { key: g.cwd, 'data-dscw-p-repofold': '', title: g.cwd },
                                  el('summary', null,
                                    el('span', null, repoName(g.cwd)),
                                    el('span', { 'data-count': '' }, String(gj.length))),
                                  el('div', { 'data-body': '' }, gj.map((j) => jobCard(j))))
                              })))
                          : null,
                      ))
                : null,
                ),
            )
          } catch (e) {
            // 渲染构建期异常直接显形，避免整块白屏无从排查
            return el('div', { 'data-dscw-p-page': '' },
              el('div', { 'data-dscw-p-empty': '' }, `Panel error: ${String(e?.stack ?? e)}`))
          }
        }

        function PanelIcon(props) {
          const size = (props && props.size) || 16
          return el('svg', {
            viewBox: '0 0 16 16', width: size, height: size,
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
            strokeLinecap: 'round', strokeLinejoin: 'round',
          },
            // 摊开的书：wiki 页
            el('path', { d: 'M2 3.2h4.4c.9 0 1.6.7 1.6 1.6v8c0-.9-.7-1.6-1.6-1.6H2z' }),
            el('path', { d: 'M14 3.2H9.6c-.9 0-1.6.7-1.6 1.6v8c0-.9.7-1.6 1.6-1.6H14z' }),
          )
        }
      },
    }
  },
})
