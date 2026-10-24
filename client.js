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
    const MODELS_PATH = '/api/codewiki/models'
    const EFFORTS_PATH = '/api/codewiki/model-efforts'
    const REPOS_POLL_MS = 10000
    // queued 单列在最前：单项目串行时后提交的项目在此等待，阶段条第 0 个点亮表示排队
    const ACTIVE_STAGES = ['queued', 'articles', 'crosscut', 'compose', 'review', 'index']

    const zh = () => ({
      title: 'CodeWiki',
      summary: '随仓库的代码 wiki（<repo>/.codewiki/）：全批量流水线编译（零子代理），侧边栏面板可看进度。',
      intro: '维护各仓库 .codewiki/ 目录下的活 wiki（随仓库提交共享）。此处设置经 configForms 热生效，无需重启。',
      secRun: '运行',
      enabled: '启用插件',
      enabledHint: '停用后 cw 与 codewiki_generate 两个工具立即报错。',
      updateReminder: 'wiki 维护提醒',
      updateReminderHint: '会话系统提示注入收尾提醒：仅当会话仓库根存在 wiki 入口 CodeWiki.md 时出现，提醒改完代码后更新 wiki。',
      autoCommit: '自动提交编译产物',
      autoCommitHint: '开启后编译完成由插件自己提交产物（只 add .codewiki/ 与 CodeWiki.md，建议 docs(wiki) 前缀，不跑仓库钩子，不动你其它改动）：会话模型因此无需等待编译完成、也无需代跑 git，编译成功时也不会再唤醒会话。关闭或提交失败（非 git 仓库、路径被忽略、合并中、未配 user.name 等）时降级为「产物待提交」提醒。',
      workspaceOnly: '只显示工作区任务',
      workspaceOnlyHint: '任务页只显示属于已添加 dsh 工作区（侧边栏工作区列表）的任务，Temp 沙箱等任意路径任务不显示。宿主未注册工作区时不过滤。',
      maxConcurrency: '编译并发上限',
      maxConcurrencyHint: '1–8；硬顶 8。插件内并发池的请求数（默认 2，适合免费 hy3 档）。',
      serialProjects: '单项目串行',
      serialProjectsHint: '开启后同一时刻只推进一个仓库的编译任务，后提交的项目排队（queued），前一个收尾后自动轮到我——避免多项目同时编译抢占同一个免费额度与并发。',
      secCompile: '编译模型',
      secCompileHint: '全部模型环节（写文章/横切/校对）共用一个模型，全部在插件内完成，不再委托发起会话的主模型。可选模型设置里已配置的任意提供商（含本地 OpenAI 兼容端点）。',
      batchProvider: '模型提供商',
      batchProviderHint: '来自模型设置里已注册的提供商。默认 workbuddy（免费 hy3，192k 上下文）。插件没有自带直连通道，模型与凭证都取自模型设置里选中的这一份。',
      batchProviderMissing: '目录不可用，请手填 provider id',
      batchModel: '编译模型',
      batchModelHint: '该提供商下的模型 id。目录里没有的模型可直接手填。',
      batchModelManual: '手填模型 id…',
      catalogLoading: '正在读取模型目录…',
      catalogUnavailable: '模型目录不可用（{error}）——可手填提供商与模型 id。',
      catalogEmptyModels: '该提供商没有可枚举的模型，请手填模型 id。',
      batchReasoningEffort: '思考程度',
      batchReasoningEffortHint: '档位直接取自模型目录（该模型声明的 reasoning efforts）。留空=用模型默认档。',
      batchReasoningEffortModel: '模型默认',
      batchReasoningEffortLoading: '正在读取该模型的思考档位…',
      batchReasoningEffortNone: '该模型未声明可选思考档位，只能用默认档。',
      batchReasoningEffortError: '读取思考档位失败（{error}）——先用模型默认档。',
      secBig: '大档模型（超长输入）',
      secBigHint: '当某个模块的源码超过普通档单请求预算（110k）时，改用这里的模型在插件内一次写完——不再把超大内容交给会话模型，也就没有「超 256k 就写不了」这回事。默认火山方舟 glm-5.3-flash（512k 上下文）。留空提供商 = 关闭大档，退回会话通道兜底。',
      bigProvider: '大档提供商',
      bigProviderOff: '（未启用大档）',
      bigProviderHint: '来自模型设置里已注册的提供商。默认火山方舟（volces-ark）。留空则关闭大档通道。',
      bigModel: '大档模型',
      bigModelHint: '该提供商下的模型 id。默认 glm-5.3-flash（512k 上下文）。',
      bigReasoningEffort: '大档思考程度',
      bigReasoningEffortHint: '档位取自模型目录。留空=用模型默认档。',
      bigTokenBudget: '大档输入预算（token）',
      bigTokenBudgetHint: '大档单请求输入预算，默认 420000。须大于普通预算 110000，且不超过模型上下文窗口扣除输出后的空间。',
      bigDisabled: '大档通道已关闭（提供商留空）——超大输入将退回会话通道兜底。',
      sessionTier: '兜底档位',
      sessionTierHint: '仅在关闭大档、且单文件连大档都装不下时才会用到：派给哪个子智能体档位（dsh-subagent-auto-router 里的档位 id）。留空=自动选路。',
      articleLanguage: '文章语言',
      binaryPath: 'cw 可执行路径',
      binaryPathHint: '留空优先用 PATH 里的 cw（与 codewiki 源码同步），找不到再用插件自带 bin/cw.exe。',
      save: '保存',
      discard: '放弃更改',
      saved: '已保存。',
      loadingLabel: '加载中…',
      conflict: '保存冲突：设置已被他处修改，请重试。',
      invalidConcurrency: '并发上限须为 1–8 的整数。',
      panelTitle: '编译任务',
      panelEmpty: '暂无编译任务——在会话里运行 codewiki_generate 开始编译。',
      stageQueued: '排队中',
      stageArticles: '写文章中',
      stageCrosscut: '横切中',
      stageCompose: '合成中',
      stageReview: '校对中',
      stageIndex: '建索引中',
      stageDone: '已完成',
      stageFailed: '失败',
      stageCancelled: '已取消',
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
      autoUpdateHint: '定时扫描已编译过的工作区，检测到变更自动提交增量编译（scope=auto）。',
      autoUpdateMinLabel: '扫描间隔（分钟）',
      autoUpdateMinHint: '最小 5；扫描对 jobs 历史工作区逐个 cw status 判态，仅提交有变更的。',
      excludePathsLabel: '排除清单',
      excludePathsHint: '这些目录（含子目录）不编译 CodeWiki；换行/分号/逗号分隔绝对路径。',
      stepArticles: '文章',
      stepCrosscut: '横切',
      stepCompose: '合成',
      stepReview: '校对',
      stepIndex: '索引',
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
      lastCompile: '上次编译',
      nextScan: '下次扫描',
      scannedLabel: '扫描',
      submittedLabel: '提交',
      totalTimeLabel: '总耗时',
      copyPath: '复制路径',
      copiedLabel: '已复制',
      runningCount: '个进行中',
      agoSuffix: '前',
    })
    const en = () => ({
      title: 'CodeWiki',
      summary: 'Repo-local code wiki (<repo>/.codewiki/): all-batch pipeline (zero subagents); track progress in the sidebar panel.',
      intro: 'Maintains a living wiki inside each repository at .codewiki/ (committed and shared with the repo). Settings here apply hot via configForms — no restart needed.',
      secRun: 'Runtime',
      enabled: 'Enable plugin',
      enabledHint: 'When off, the cw and codewiki_generate tools error immediately.',
      updateReminder: 'Wiki update reminder',
      updateReminderHint: 'Injects a wrap-up reminder into the session system prompt — only when the session repo has a .codewiki/.',
      autoCommit: 'Auto-commit compiled wiki',
      autoCommitHint: 'When on, the plugin commits the artifacts itself once compilation finishes (only .codewiki/ and CodeWiki.md, docs(wiki) prefix suggested, no repo hooks, your other changes untouched): the session model then never has to wait for compilation or run git, and a successful compile never wakes the session. When off, or when the commit is refused (not a git repo, paths ignored, merge in progress, missing user.name, …) it degrades to a one-shot "artifacts pending" reminder.',
      workspaceOnly: 'Workspace tasks only',
      workspaceOnlyHint: 'The jobs tab shows only tasks belonging to added dsh workspaces (the sidebar workspace list); Temp-sandbox and arbitrary-path tasks are hidden. No filtering when the host has no registered workspaces.',
      maxConcurrency: 'Compile concurrency',
      maxConcurrencyHint: '1–8; hard cap 8. Requests in the in-plugin pool (default 2, suited to the free hy3 tier).',
      serialProjects: 'One project at a time',
      serialProjectsHint: 'When on, only one repository compiles at a time; later submissions queue (queued) and start automatically once the current one finishes — so free quota and concurrency are never shared across projects.',
      secCompile: 'Compile model',
      secCompileHint: 'Every model step (plan / articles / crosscut / proofreading) shares one model and runs entirely inside the plugin — the initiating session model is no longer delegated to. Pick any provider configured in model settings (local OpenAI-compatible endpoints included). The plugin has no built-in channel of its own: model and credentials both come from the selected entry.',
      batchProvider: 'Model provider',
      batchProviderHint: 'Providers registered in model settings. Default workbuddy (free hy3, 192k context). The plugin has no built-in direct channel — model and credentials are taken from the selected entry here.',
      batchProviderMissing: 'Catalog unavailable — type the provider id',
      batchModel: 'Compile model',
      batchModelHint: 'Model id under that provider. Ids missing from the catalog can be typed in.',
      batchModelManual: 'Type a model id…',
      catalogLoading: 'Reading the model catalog…',
      catalogUnavailable: 'Model catalog unavailable ({error}) — type the provider and model id instead.',
      catalogEmptyModels: 'This provider exposes no enumerable models; type the model id.',
      batchReasoningEffort: 'Reasoning effort',
      batchReasoningEffortHint: 'Options come straight from the model catalog (the efforts that model declares). Empty = the model\'s default effort.',
      batchReasoningEffortModel: 'Model default',
      batchReasoningEffortLoading: 'Reading this model\'s reasoning efforts…',
      batchReasoningEffortNone: 'This model declares no selectable efforts; only the default applies.',
      batchReasoningEffortError: 'Could not read reasoning efforts ({error}) — keeping the model default.',
      secBig: 'Large-input model',
      secBigHint: 'When a module\'s sources exceed the normal single-request budget (110k), this model writes it in the plugin in one pass — oversized content never goes to the session model, so there is no "too big past 256k" ceiling. Default: Volcengine Ark glm-5.3-flash (512k context). Empty provider = the large tier is off and oversized input falls back to the session channel.',
      bigProvider: 'Large-tier provider',
      bigProviderOff: '(large tier off)',
      bigProviderHint: 'A provider registered in model settings. Default Volcengine Ark (volces-ark). Empty disables the large tier.',
      bigModel: 'Large-tier model',
      bigModelHint: 'Model id under that provider. Default glm-5.3-flash (512k context).',
      bigReasoningEffort: 'Large-tier reasoning effort',
      bigReasoningEffortHint: 'Options come from the model catalog. Empty = the model\'s default effort.',
      bigTokenBudget: 'Large-tier input budget (tokens)',
      bigTokenBudgetHint: 'Single-request input budget for the large tier, default 420000. Must exceed the normal 110000 and fit in the model context window after reserving output.',
      bigDisabled: 'Large tier off (empty provider) — oversized input falls back to the session channel.',
      sessionTier: 'Fallback tier',
      sessionTierHint: 'Only reachable when the large tier is off and even it cannot fit the file: which subagent tier (id from dsh-subagent-auto-router) receives it. Empty = automatic routing.',
      articleLanguage: 'Article language',
      binaryPath: 'cw binary path',
      binaryPathHint: 'Empty = cw on PATH first (kept in sync with the codewiki source), bundled bin/cw.exe as fallback.',
      save: 'Save',
      discard: 'Discard changes',
      saved: 'Saved.',
      loadingLabel: 'Loading…',
      conflict: 'Save conflict: settings changed elsewhere, please retry.',
      invalidConcurrency: 'Concurrency cap must be an integer between 1 and 8.',
      panelTitle: 'Compilation jobs',
      panelEmpty: 'No compilation jobs yet — run codewiki_generate in a session to start one.',
      stageQueued: 'Queued',
      stageArticles: 'Writing articles',
      stageCrosscut: 'Cross-cutting',
      stageCompose: 'Composing',
      stageReview: 'Proofreading',
      stageIndex: 'Indexing',
      stepQueued: 'Queue',
      stageDone: 'Done',
      stageFailed: 'Failed',
      stageCancelled: 'Cancelled',
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
      excludePathsHint: 'CodeWiki is never compiled under these directories (subtree included). Separate absolute paths with newlines, semicolons or commas.',
      stepArticles: 'Write',
      stepCrosscut: 'Cross',
      stepCompose: 'Compose',
      stepReview: 'Proof',
      stepIndex: 'Index',
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
      lastCompile: 'last compile',
      nextScan: 'Next scan',
      scannedLabel: 'scanned',
      submittedLabel: 'submitted',
      totalTimeLabel: 'total',
      copyPath: 'Copy path',
      copiedLabel: 'Copied',
      runningCount: 'running',
      agoSuffix: 'ago',
    })

    const style = document.createElement('style')
    style.dataset.plugin = '@local/dsh-codewiki'
    style.textContent = [
      '[data-dscw-page] { display: flex; flex-direction: column; gap: 24px; max-width: 880px; color: var(--dsw-alias-label-primary); }',
      '[data-dscw-head] { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }',
      '[data-dscw-head] h4 { margin: 0; font-size: 14px; font-weight: 500; line-height: 22px; }',
      '[data-dscw-hint] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-grid] { display: grid; grid-template-columns: 160px minmax(0, 1fr); align-items: center; gap: 10px 16px; }',
      '[data-dscw-grid] > label { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-field] { display: flex; flex-direction: column; gap: 4px; }',
      '[data-dscw-select] { width: 100%; font: inherit; font-size: 12px; line-height: 18px; padding: 6px 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); box-sizing: border-box; }',
      '[data-dscw-bar] { display: flex; align-items: center; gap: 8px; padding: 10px 0 0; border-top: 0.5px solid var(--dsw-alias-border-l3); }',
      '[data-dscw-notice] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-warn] { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)); font-size: 12px; line-height: 18px; }',
      // 侧边栏面板
      '[data-dscw-p-page] { display: flex; flex-direction: column; gap: 12px; padding: 16px; font-size: 13px; color: var(--dsw-alias-label-primary); box-sizing: border-box; height: 100%; overflow-y: auto; }',
      '[data-dscw-p-page] * { box-sizing: border-box; }',
      '[data-dscw-p-head] { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
      '[data-dscw-p-head] h3 { margin: 0; font-size: 14px; font-weight: 500; line-height: 22px; }',
      '[data-dscw-p-job] { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 10px; }',
      '[data-dscw-p-row] { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '[data-dscw-p-stage] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-stage][data-state="done"] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-stage][data-state="failed"] { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-stage][data-state="cancelled"] { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-meta] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); word-break: break-all; }',
      '[data-dscw-p-note] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }',
      '[data-dscw-p-empty] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); padding: 8px 0; }',
      '[data-dscw-p-group] { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); margin-top: 4px; word-break: break-all; }',
      '[data-dscw-p-history] { margin-top: 12px; }',
      '[data-dscw-p-history] summary { cursor: pointer; user-select: none; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }',
      '[data-dscw-p-job][data-active="true"] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent); }',
      '[data-dscw-p-stage][data-running="true"] { animation: dscw-pulse 1.6s ease-in-out infinite; }',
      '@keyframes dscw-pulse { 50% { opacity: 0.45; } }',
      '[data-dscw-p-settings] { padding: 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 10px; }',
      '[data-dscw-p-tabs] { display: flex; gap: 2px; background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 8px; padding: 2px; width: max-content; max-width: 100%; }',
      '[data-dscw-p-tab] { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1; padding: 5px 12px; border-radius: 6px; cursor: pointer; }',
      '[data-dscw-p-tab]:hover { color: var(--dsw-alias-label-primary); }',
      '[data-dscw-p-tab][data-on="true"] { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color: var(--dsw-alias-label-primary-foreground, #fff); }',
      '[data-dscw-p-stage][data-state="clean"] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-stage][data-state="stale"] { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)); }',
      '[data-dscw-p-stage][data-state="missing"], [data-dscw-p-stage][data-state="uncompiled"] { color: var(--dsw-alias-label-tertiary); }',
      '[data-dscw-p-sched] { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-p-repo] { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 10px; }',
      '[data-dscw-p-bar] { height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); overflow: hidden; }',
      '[data-dscw-p-barfill] { height: 100%; border-radius: 2px; background: var(--dsw-alias-brand-primary); transition: width 0.4s ease; }',
      '[data-dscw-p-tasklist] { display: flex; flex-direction: column; gap: 1px; max-height: 180px; overflow-y: auto; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-p-task] { display: flex; gap: 6px; align-items: baseline; }',
      '[data-dscw-p-task] [data-mark] { flex: none; width: 12px; text-align: center; }',
      '[data-dscw-p-task][data-state="done"] [data-mark] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-task][data-state="failed"] [data-mark] { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-textarea] { width: 100%; min-height: 64px; resize: vertical; font: inherit; font-size: 12px; line-height: 18px; padding: 6px 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); box-sizing: border-box; }',
      // 六阶段步骤条
      '[data-dscw-p-steps] { display: flex; align-items: flex-start; margin-top: 2px; }',
      '[data-dscw-p-step] { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 3px; position: relative; }',
      '[data-dscw-p-step]:not(:first-child)::before { content: ""; position: absolute; top: 5px; left: -50%; width: 100%; height: 1.5px; background: var(--dsw-alias-border-l3); }',
      '[data-dscw-p-step][data-done="true"]::before { background: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)); }',
      '[data-dscw-p-dot] { position: relative; z-index: 1; width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-2)); box-sizing: border-box; }',
      '[data-dscw-p-step][data-done="true"] [data-dscw-p-dot] { background: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)); border-color: transparent; }',
      '[data-dscw-p-step][data-running="true"] [data-dscw-p-dot] { border-color: var(--dsw-alias-brand-primary); }',
      '[data-dscw-p-step][data-failed="true"] [data-dscw-p-dot] { background: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); border-color: transparent; }',
      '[data-dscw-p-step][data-cancelled="true"] [data-dscw-p-dot] { background: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)); border-color: transparent; }',
      '[data-dscw-p-step] > span:last-child { font-size: 10px; line-height: 13px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; font-variant-numeric: tabular-nums; }',
      '[data-dscw-p-step][data-done="true"] > span:last-child, [data-dscw-p-step][data-running="true"] > span:last-child { color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-p-step][data-failed="true"] > span:last-child { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); }',
      '[data-dscw-p-step][data-cancelled="true"] > span:last-child { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)); }',
      // 吞吐徽标（tok/s + spark，或批量 篇/分 + ETA）
      '[data-dscw-p-badge] { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 999px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }',
      '[data-dscw-p-badge][data-tone="live"] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, currentColor) 40%, transparent); }',
      '[data-dscw-p-badge] svg { display: block; }',
      // 用量行 / 错误行 / 活动流
      '[data-dscw-p-usage] { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; word-break: break-all; }',
      '[data-dscw-p-usage] [data-warn] { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)); }',
      '[data-dscw-p-error] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); word-break: break-all; }',
      '[data-dscw-p-activity] { margin-top: 2px; }',
      '[data-dscw-p-activity] summary { cursor: pointer; user-select: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }',
      '[data-dscw-p-activity] > div { margin-top: 4px; display: flex; flex-direction: column; gap: 3px; padding-left: 8px; border-left: 2px solid var(--dsw-alias-border-l3); }',
      '[data-dscw-p-activity] > div > div { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); word-break: break-all; }',
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

        function CodewikiCard(props) {
          const t = props?.t ?? tBound

          const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
          const [draft, setDraft] = React.useState(null)
          const [notice, setNotice] = React.useState(null)
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

          const dirty = React.useMemo(() => {
            if (!snapshot?.value || !draft) return false
            return JSON.stringify(draft) !== JSON.stringify(snapshot.value)
          }, [snapshot, draft])

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
          // allowEmptyProvider=true 时多给一个「（未启用）」空选项（大档留空 = 关闭）。
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
                    // 目录说该模型没有可选档位：只给「默认」并清空残留值
                    return el('div', { 'data-dscw-field': '' },
                      el('select', {
                        'data-dscw-select': '',
                        value: '',
                        onChange: () => setPath(eKey, ''),
                      },
                        el('option', { value: '' }, t('batchReasoningEffortModel')),
                      ),
                      el('div', { 'data-dscw-hint': '' }, t('batchReasoningEffortNone')),
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

          const save = async () => {
            if (!snapshot?.writable || snapshot.status !== 'ready') return
            const concurrency = Number(draft?.maxConcurrency)
            if (Number.isFinite(concurrency) && (concurrency < 1 || concurrency > 8 || !Number.isInteger(concurrency))) {
              setError(t('invalidConcurrency'))
              return
            }
            const base = snapshot.value ?? {}
            const ops = []
            for (const key of ['enabled', 'binaryPath', 'maxConcurrency', 'serialProjects', 'articleLanguage', 'updateReminder', 'autoCommit', 'workspaceOnly', 'batchProvider', 'batchModel', 'batchReasoningEffort', 'bigProvider', 'bigModel', 'bigReasoningEffort', 'bigTokenBudget', 'sessionTier', 'excludePaths', 'autoUpdate', 'autoUpdateMin']) {
              if (JSON.stringify(draft?.[key]) !== JSON.stringify(base[key])) {
                ops.push({ op: 'set', path: [key], value: draft?.[key] })
              }
            }
            if (!ops.length) { setNotice(t('saved')); return }
            try {
              const accepted = await form.mutate(ops, snapshot.revision)
              setNotice(accepted ? t('saved') : t('conflict'))
              if (accepted) setError(null)
            } catch (err) {
              setError(String(err?.message ?? err))
            }
          }

          const discard = () => {
            if (snapshot?.value) setDraft(structuredClone(snapshot.value))
            setNotice(null)
            setError(null)
          }

          if (snapshot.status === 'loading' || snapshot.status === 'unavailable' || !draft) {
            return el('div', { 'data-dscw-page': '' }, el('div', { 'data-dscw-notice': '' }, t('loadingLabel')))
          }

          return el('div', { 'data-dscw-page': '' },
            el('div', { 'data-dscw-hint': '' }, t('intro')),
            // 运行
            el('section', { 'data-dscw-field': '' },
              el('div', { 'data-dscw-head': '' }, el('h4', null, t('secRun'))),
              el('div', { 'data-dscw-grid': '' },
                el('label', null, t('enabled')),
                el('div', { 'data-dscw-field': '' },
                  el(Switch, {
                    checked: draft.enabled !== false,
                    onChange: (v) => setPath('enabled', v),
                    label: t('enabled'),
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('enabledHint')),
                ),
                el('label', null, t('updateReminder')),
                el('div', { 'data-dscw-field': '' },
                  el(Switch, {
                    checked: draft.updateReminder !== false,
                    onChange: (v) => setPath('updateReminder', v),
                    label: t('updateReminder'),
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('updateReminderHint')),
                ),
                el('label', null, t('autoCommit')),
                el('div', { 'data-dscw-field': '' },
                  el(Switch, {
                    checked: draft.autoCommit !== false,
                    onChange: (v) => setPath('autoCommit', v),
                    label: t('autoCommit'),
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('autoCommitHint')),
                ),
                el('label', null, t('workspaceOnly')),
                el('div', { 'data-dscw-field': '' },
                  el(Switch, {
                    checked: draft.workspaceOnly !== false,
                    onChange: (v) => setPath('workspaceOnly', v),
                    label: t('workspaceOnly'),
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('workspaceOnlyHint')),
                ),
                el('label', null, t('maxConcurrency')),
                el('div', { 'data-dscw-field': '' },
                  el(Input, {
                    value: String(draft.maxConcurrency ?? 2),
                    onChange: (e) => setPath('maxConcurrency', Number(e.target.value)),
                    placeholder: '2',
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('maxConcurrencyHint')),
                ),
                el('label', null, t('serialProjects')),
                el('div', { 'data-dscw-field': '' },
                  el(Switch, {
                    checked: draft.serialProjects !== false,
                    onChange: (v) => setPath('serialProjects', v),
                    label: t('serialProjects'),
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('serialProjectsHint')),
                ),
                el('label', null, t('articleLanguage')),
                el(Input, {
                  value: String(draft.articleLanguage ?? ''),
                  onChange: (e) => setPath('articleLanguage', e.target.value),
                  placeholder: '中文',
                }),
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
            // 编译模型（唯一通道：模型设置里已注册的 provider/model）
            el('section', { 'data-dscw-field': '' },
              el('div', { 'data-dscw-head': '' }, el('h4', null, t('secCompile'))),
              el('div', { 'data-dscw-hint': '' }, t('secCompileHint')),
              el('div', { 'data-dscw-grid': '' },
                ...modelTrio({ pKey: 'batchProvider', mKey: 'batchModel', eKey: 'batchReasoningEffort', state: effortsState, allowEmptyProvider: false, providerPlaceholder: 'workbuddy' }),
                el('label', null, t('sessionTier')),
                el('div', { 'data-dscw-field': '' },
                  el(Input, {
                    value: String(draft.sessionTier ?? ''),
                    onChange: (e) => setPath('sessionTier', e.target.value),
                    placeholder: 'default',
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('sessionTierHint')),
                ),
              ),
            ),
            // 大档模型（超长输入）：超过普通档单请求预算的模块改用它，仍全部在插件内完成
            el('section', { 'data-dscw-field': '' },
              el('div', { 'data-dscw-head': '' }, el('h4', null, t('secBig'))),
              el('div', { 'data-dscw-hint': '' }, t('secBigHint')),
              el('div', { 'data-dscw-grid': '' },
                ...modelTrio({ pKey: 'bigProvider', mKey: 'bigModel', eKey: 'bigReasoningEffort', state: bigEffortsState, allowEmptyProvider: true, providerPlaceholder: 'volces-ark' }),
                el('label', null, t('bigTokenBudget')),
                el('div', { 'data-dscw-field': '' },
                  el(Input, {
                    value: String(draft.bigTokenBudget ?? ''),
                    onChange: (e) => setPath('bigTokenBudget', e.target.value),
                    placeholder: '420000',
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('bigTokenBudgetHint')),
                ),
              ),
            ),
                        // 调度与排除
            el('section', { 'data-dscw-field': '' },
              el('div', { 'data-dscw-head': '' }, el('h4', null, t('secSchedule'))),
              el('div', { 'data-dscw-grid': '' },
                el('label', null, t('autoUpdateLabel')),
                el('div', { 'data-dscw-field': '' },
                  el(Switch, {
                    checked: draft.autoUpdate === true,
                    onChange: (v) => setPath('autoUpdate', v),
                    label: t('autoUpdateLabel'),
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('autoUpdateHint')),
                ),
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
                    placeholder: 'E:\path\to\excluded-repo',
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('excludePathsHint')),
                ),
              ),
            ),
            // 保存条
            el('div', { 'data-dscw-bar': '' },
              el(Button, { variant: 'ghost', size: 'sm', onClick: discard, disabled: !dirty }, t('discard')),
              el(Button, { size: 'sm', onClick: save, disabled: !dirty || !snapshot.writable }, t('save')),
              error
                ? el('span', { 'data-dscw-warn': '' }, error)
                : (!dirty && notice ? el(Tag, null, notice) : null),
            ),
          )
        }

        // -------------------------------------------------------------------
        // 侧边栏面板：编译任务进度 + 取消（轮询 jobs 端点）
        // -------------------------------------------------------------------

        const stageLabel = (stage) => tBound(`stage${String(stage).charAt(0).toUpperCase()}${String(stage).slice(1)}`)
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
          const s = Math.max(0, Math.floor(ms / 1000))
          const h = Math.floor(s / 3600)
          const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
          const ss = String(s % 60).padStart(2, '0')
          return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
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

        // 六阶段步骤条：已完成绿点（title 带各阶段耗时）、当前阶段实心点+实时计时、
        // 失败/取消在最后计时段标红/黄。终态 done 全绿。
        const stepName = (s) => tBound(`step${s.charAt(0).toUpperCase()}${s.slice(1)}`)
        // 旧任务可能残留已删阶段（如 plan）的计时键——过滤掉，避免 indexOf 得 -1
        // 导致失败/取消时 failIdx 失效、步骤条全熄不标红
        const lastTimedStage = (job) => {
          const keys = Object.keys(job.stageTimings ?? {}).filter((k) => ACTIVE_STAGES.includes(k))
          return keys.length ? keys[keys.length - 1] : null
        }
        const stageBar = (job) => {
          const idx = ACTIVE_STAGES.indexOf(job.stage)
          const terminal = idx < 0
          const failIdx = terminal && job.stage !== 'done' ? ACTIVE_STAGES.indexOf(lastTimedStage(job)) : -1
          return el('div', { 'data-dscw-p-steps': '' },
            ACTIVE_STAGES.map((s, i) => {
              const done = terminal ? ((failIdx < 0 && job.stage === 'done') || i < failIdx) : i < idx
              const running = !terminal && i === idx
              const failedStep = terminal && failIdx >= 0 && i === failIdx
              const dur = job.stageTimings?.[s]
              const live = running && job.stageStartedAt ? ` ${fmtMs(Date.now() - Date.parse(job.stageStartedAt))}` : ''
              const label = `${stepName(s)}${running || failedStep ? (live || (dur ? ` ${fmtMs(dur)}` : '')) : ''}`
              return el('div', {
                key: s, 'data-dscw-p-step': '',
                'data-done': done ? 'true' : null,
                'data-running': running ? 'true' : null,
                'data-failed': failedStep && job.stage === 'failed' ? 'true' : null,
                'data-cancelled': failedStep && job.stage === 'cancelled' ? 'true' : null,
              },
                el('span', { 'data-dscw-p-dot': '' }),
                el('span', { title: `${stageLabel(s)}${dur ? ` · ${fmtMs(dur)}` : ''}` }, label))
            }))
        }
        // 总进度：五阶段定权线性推进，阶段内按 taskList 完成数折算；封顶 99，done 才 100
        const STAGE_WEIGHTS = { queued: 0, articles: 0.65, crosscut: 0.1, compose: 0.05, review: 0.15, index: 0.05 }
        const overallPct = (job) => {
          const idx = ACTIVE_STAGES.indexOf(job.stage)
          if (idx < 0) return job.stage === 'done' ? 100 : null
          let pct = 0
          for (let i = 0; i < idx; i++) pct += STAGE_WEIGHTS[ACTIVE_STAGES[i]] ?? 0
          const tl = Array.isArray(job.taskList) ? job.taskList : []
          const frac = tl.length ? tl.filter((x) => x.state === 'done').length / tl.length : 0
          return Math.min(99, Math.round((pct + (STAGE_WEIGHTS[job.stage] ?? 0) * frac) * 100))
        }
        // 吞吐徽标：实时通道显示 tok/s + spark；批量通道显示完成速率（篇/分，EWMA 平滑）+ ETA；
        // 批次尚无完成样本时显示排队/执行时长（batchSubmittedAt 起算）
        const throughputBadge = (job, sparkOf, rateOf) => {
          if (!ACTIVE_STAGES.includes(job.stage)) return null
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
          return el('div', { 'data-dscw-p-usage': '' },
            bits.join(' · '),
            u.overTier2 ? el('span', { 'data-warn': '' }, ` · ${u.overTier2} ${tBound('overTierLabel')}`) : null)
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
            return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
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
              repos.length
                ? repos.map((r) => {
                  const st = String(r.state ?? 'error')
                  const stState = st === 'clean' ? 'done' : st === 'stale' ? 'stale' : st === 'error' ? 'failed' : 'cancelled'
                  return el('div', { key: r.cwd, 'data-dscw-p-repo': '' },
                    el('div', { 'data-dscw-p-row': '' },
                      el('span', { style: { fontWeight: 500 }, title: r.cwd }, repoName(r.cwd)),
                      r.excluded ? el(Tag, null, t('excludedTag')) : null,
                      el('span', { 'data-dscw-p-stage': '', 'data-state': stState }, stateLabel(st)),
                      st === 'stale'
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
                      const ljActive = lj && !['done', 'failed', 'cancelled'].includes(lj.stage)
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
                        parts.length ? el('div', { 'data-dscw-p-meta': '' }, parts.join(' · ')) : null,
                        barTotal > 0 ? progressBar(barDone, barTotal) : null,
                      )
                    })(),
                  )
                })
                : el('div', { 'data-dscw-p-empty': '' }, t('reposEmpty')),
            )
          } catch (e) {
            return el('div', { 'data-dscw-p-empty': '' }, `Repos error: ${String(e?.stack ?? e)}`)
          }
        }

        function CodewikiPanel() {
          const t = tBound
          const [jobs, setJobs] = React.useState(null) // null = 尚未拿到首轮
          const [err, setErr] = React.useState(null)
          const [busyId, setBusyId] = React.useState(null)
          const [tab, setTab] = React.useState('overview')
          const [copiedPath, setCopiedPath] = React.useState(null)
          // 面板侧采样（2s 轮询差分）：tps 滚动窗口画 spark；批量完成速率 EWMA 算吞吐与 ETA
          const sparkRef = React.useRef(new Map()) // jobId -> number[]
          const batchRateRef = React.useRef(new Map()) // jobId -> { at, completed, rate }
          const sparkOf = (id) => sparkRef.current.get(id) ?? []
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

          const isActive = (job) => ACTIVE_STAGES.includes(job.stage)

          // 按工作区（cwd）分组；保持首次出现顺序，组内最新在前（服务历史折叠区）
          const groups = []
          const byCwd = new Map()
          for (const job of jobs ?? []) {
            let g = byCwd.get(job.cwd)
            if (!g) { g = []; byCwd.set(job.cwd, g); groups.push({ cwd: job.cwd, jobs: g }) }
            g.unshift(job)
          }

          // 焦点任务：活动优先（新→旧），无活动取最近更新的一个；其余收进「历史任务」折叠区
          const byUpdated = (a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? ''))
          const all = jobs ?? []
          const focus = (all.filter(isActive).sort(byUpdated))[0] ?? [...all].sort(byUpdated)[0] ?? null
          const rest = all.filter((j) => j !== focus)

          const jobCard = (job) => {
            const active = isActive(job)
            const arts = Array.isArray(job.articles) ? job.articles : []
            const okCount = arts.filter((a) => a.ok).length
            const taskList = Array.isArray(job.taskList) ? job.taskList : []
            const total = taskList.length || arts.length
            const meta = []
            if (total) meta.push(`${t('writtenLabel')} ${okCount}/${total} ${t('unitArticle')}`)
            else if (typeof job.writtenCount === 'number') meta.push(`${t('writtenLabel')} ${job.writtenCount} ${t('unitArticle')}`)
            if (job.failedCount) meta.push(`${t('failedLabel')} ${job.failedCount}`)
            if (active && job.batchProgress) meta.push(`${t('batchLabel')} ${job.batchProgress.completed}/${job.batchProgress.total}`)
            if (active) meta.push(`${t('elapsedLabel')} ${fmtMs(Date.now() - Date.parse(job.createdAt))}`)
            else if (job.finishedAt && job.createdAt) meta.push(`${t('totalTimeLabel')} ${fmtMs(Date.parse(job.finishedAt) - Date.parse(job.createdAt))}`)
            return el('div', { key: job.id, 'data-dscw-p-job': '', 'data-active': active ? 'true' : null },
              el('div', { 'data-dscw-p-row': '' },
                el(Tag, null, kindLabel(job.kind)),
                el('span', {
                  'data-dscw-p-stage': '', 'data-state': job.stage,
                  'data-running': active ? 'true' : null,
                }, stageLabel(job.stage)),
                throughputBadge(job, sparkOf, rateOf),
                active
                  ? el(Button, {
                    variant: 'ghost', size: 'sm',
                    onClick: () => cancel(job.id),
                    disabled: busyId === job.id || job.cancelRequested === true,
                  }, job.cancelRequested === true ? t('cancelRequestedLabel') : t('cancelJob'))
                  : null,
              ),
              stageBar(job),
              meta.length ? el('div', { 'data-dscw-p-meta': '' }, meta.join(' · ')) : null,
              active ? progressBar(overallPct(job) ?? 0, 100) : null,
              usageLine(job),
              (job.notes ?? []).length
                ? el('div', { 'data-dscw-p-note': '' }, job.notes[job.notes.length - 1])
                : null,
              (job.notes ?? []).length > 1
                ? el('details', { 'data-dscw-p-activity': '' },
                  el('summary', null, `${t('activityLabel')} (${job.notes.length})`),
                  el('div', null, job.notes.map((n, i) => el('div', { key: i }, n))))
                : null,
              job.error ? el('div', { 'data-dscw-p-error': '' }, job.error) : null,
              active && taskList.length
                ? el('div', { 'data-dscw-p-tasklist': '' },
                  taskList.map((x) => el('div', { key: x.name, 'data-dscw-p-task': '', 'data-state': x.state },
                    el('span', { 'data-mark': '' }, x.state === 'done' ? '✓' : x.state === 'failed' ? '✗' : '·'),
                    el('span', null, x.name))))
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
              el('div', { 'data-dscw-p-head': '' },
                el('h3', null, t('panelTitle')),
                (jobs ?? []).filter(isActive).length
                  ? el(Tag, null, `${(jobs ?? []).filter(isActive).length} ${t('runningCount')}`)
                  : null,
              ),
              el('div', { 'data-dscw-p-tabs': '' },
                [['overview', t('tabOverview')], ['tasks', t('tabTasks')], ['settings', t('tabSettings')]].map(([id, label]) =>
                  el('button', {
                    key: id, 'data-dscw-p-tab': '',
                    'data-on': tab === id ? 'true' : null,
                    onClick: () => setTab(id),
                  }, label)),
              ),
              tab === 'overview' ? el(ReposTab) : null,
              tab === 'settings' ? el('div', { 'data-dscw-p-settings': '' }, el(CodewikiCard)) : null,
              tab === 'tasks'
                ? (err ? el('div', { 'data-dscw-p-empty': '' }, err)
                  : jobs === null
                    ? el('div', { 'data-dscw-p-empty': '' }, '…')
                    : !all.length
                      ? el('div', { 'data-dscw-p-empty': '' }, t('panelEmpty'))
                      : el(React.Fragment, null,
                        jobCard(focus),
                        rest.length
                          ? el('details', { 'data-dscw-p-history': '' },
                            el('summary', null, `${t('historyLabel')} (${rest.length})`),
                            groups.map((g) => {
                              const gj = g.jobs.filter((j) => j !== focus)
                              return gj.length
                                ? el(React.Fragment, { key: g.cwd },
                                  el('div', { 'data-dscw-p-group': '', title: g.cwd }, repoName(g.cwd)),
                                  gj.map(jobCard))
                                : null
                            }))
                          : null,
                      ))
                : null,
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
