// dsh-codewiki — 客户端半侧（浏览器）v0.4.0
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
    const REPOS_POLL_MS = 10000
    const ACTIVE_STAGES = ['plan', 'articles', 'crosscut', 'compose', 'review', 'index']

    const zh = () => ({
      title: 'CodeWiki',
      summary: '随仓库的代码 wiki（<repo>/.codewiki/）：全批量流水线编译（零子代理），侧边栏面板可看进度。',
      intro: '维护各仓库 .codewiki/ 目录下的活 wiki（随仓库提交共享）。此处设置经 configForms 热生效，无需重启。',
      secRun: '运行',
      enabled: '启用插件',
      enabledHint: '停用后 cw 与 codewiki_generate 两个工具立即报错。',
      updateReminder: 'wiki 维护提醒',
      updateReminderHint: '会话系统提示注入收尾提醒：仅当会话仓库根存在 wiki 入口 CodeWiki.md 时出现，提醒改完代码后更新 wiki。',
      workspaceOnly: '只显示工作区任务',
      workspaceOnlyHint: '任务页只显示属于已添加 dsh 工作区（侧边栏工作区列表）的任务，Temp 沙箱等任意路径任务不显示。宿主未注册工作区时不过滤。',
      maxConcurrency: '实时兑底并发上限',
      maxConcurrencyHint: '1–8；硬顶 8。仅超预算单文件的实时兑底请求使用。',
      secBatch: '批量编译（百炼）',
      secBatchHint: 'codewiki_generate 提交后由宿主服务推进阶段机（规划→写文章→横切→审校→索引），全程百炼批量推理（实时价 50%），零子代理。凭证自动取模型设置「阿里百炼云」渠道，此处可覆盖。',
      batchApiKey: '百炼 API Key',
      batchApiKeyHint: 'DashScope API Key（sk-…）。留空时自动使用模型设置「阿里百炼云」渠道的凭证；此处填写则覆盖它。',
      batchModel: '批量模型',
      batchModelHint: '默认 qwen3.7-flash；仅华北2 支持，须用别名（快照版如 qwen3.7-flash-2026-07-15 不支持批量）。',
      batchThinkingBudget: '批量思考预算',
      batchThinkingBudgetHint: '0=关思考（最省，推荐简单任务）；1–32768=开思考并限预算（轻推理 1024，复杂 4096–8192）。思考 Token 计入输出计费。',
      batchMinTokens: '阶段实时阈值',
      batchMinTokensHint: '单阶段请求输入估算低于该值（token）时走实时并发推理（免批量排队，快）；≥ 该值才提交百炼批量（实时价 5 折）。0=全部走批量。大仓库想强制全部实时，可设 99999999。',
      invalidBatchMinTokens: '阶段实时阈值须为 0–99999999 的整数',
      invalidBatchThinking: '批量思考预算须为 0–32768 的整数。',
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
      stagePlan: '规划中',
      stageArticles: '写文章中',
      stageCrosscut: '横切中',
      stageCompose: '合成中',
      stageReview: '校对中',
      stageIndex: '建索引中',
      stageDone: '已完成',
      stageFailed: '失败',
      stageCancelled: '已取消',
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
      workspaceOnly: 'Workspace tasks only',
      workspaceOnlyHint: 'The jobs tab shows only tasks belonging to added dsh workspaces (the sidebar workspace list); Temp-sandbox and arbitrary-path tasks are hidden. No filtering when the host has no registered workspaces.',
      maxConcurrency: 'Realtime fallback concurrency',
      maxConcurrencyHint: '1–8; hard cap 8. Used only by realtime fallback requests for oversized single files.',
      secBatch: 'Batch compilation (Bailian)',
      secBatchHint: 'After codewiki_generate submits, a host service drives the stage machine (plan → articles → crosscut → review → index) entirely through Bailian batch inference (50% of realtime price), zero subagents. Credentials come from the "阿里百炼云" provider in model settings; override here if needed.',
      batchApiKey: 'Bailian API key',
      batchApiKeyHint: 'DashScope API key (sk-…). Leave empty to reuse the credential of the "阿里百炼云" provider from model settings; a value here overrides it.',
      batchModel: 'Batch model',
      batchModelHint: 'Default qwen3.7-flash; North China 2 only, alias required (e.g. the qwen3.7-flash-2026-07-15 snapshot does not support batch).',
      batchThinkingBudget: 'Batch thinking budget',
      batchThinkingBudgetHint: '0 = thinking off (cheapest, recommended for small tasks); 1–32768 = thinking on with a budget (1024 light, 4096–8192 complex). Thinking tokens bill as output.',
      batchMinTokens: 'Stage realtime threshold',
      batchMinTokensHint: 'When a stage\'s estimated prompt input is below this many tokens, run it via realtime concurrent calls (no batch queueing, faster); at or above it, submit to Bailian batch (50% of realtime price). 0 = always batch. To force realtime for large repos, set 99999999.',
      invalidBatchMinTokens: 'Stage realtime threshold must be an integer 0–99999999',
      invalidBatchThinking: 'Batch thinking budget must be an integer between 0 and 32768.',
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
      stagePlan: 'Planning',
      stageArticles: 'Writing articles',
      stageCrosscut: 'Cross-cutting',
      stageCompose: 'Composing',
      stageReview: 'Proofreading',
      stageIndex: 'Indexing',
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
      '[data-dscw-p-elapsed] { font-variant-numeric: tabular-nums; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
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

          const save = async () => {
            if (!snapshot?.writable || snapshot.status !== 'ready') return
            const concurrency = Number(draft?.maxConcurrency)
            if (Number.isFinite(concurrency) && (concurrency < 1 || concurrency > 8 || !Number.isInteger(concurrency))) {
              setError(t('invalidConcurrency'))
              return
            }
            const thinking = Number(draft?.batchThinkingBudget)
            if (Number.isFinite(thinking) && (thinking < 0 || thinking > 32768 || !Number.isInteger(thinking))) {
              setError(t('invalidBatchThinking'))
              return
            }
            const minTok = Number(draft?.batchMinTokens)
            if (Number.isFinite(minTok) && (minTok < 0 || minTok > 99999999 || !Number.isInteger(minTok))) {
              setError(t('invalidBatchMinTokens'))
              return
            }
            const base = snapshot.value ?? {}
            const ops = []
            for (const key of ['enabled', 'binaryPath', 'maxConcurrency', 'articleLanguage', 'updateReminder', 'workspaceOnly', 'batchApiKey', 'batchModel', 'batchThinkingBudget', 'batchMinTokens', 'excludePaths', 'autoUpdate', 'autoUpdateMin']) {
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
                    value: String(draft.maxConcurrency ?? 8),
                    onChange: (e) => setPath('maxConcurrency', Number(e.target.value)),
                    placeholder: '8',
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('maxConcurrencyHint')),
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
            // 批量编译（百炼）
            el('section', { 'data-dscw-field': '' },
              el('div', { 'data-dscw-head': '' }, el('h4', null, t('secBatch'))),
              el('div', { 'data-dscw-hint': '' }, t('secBatchHint')),
              el('div', { 'data-dscw-grid': '' },
                el('label', null, t('batchApiKey')),
                el('div', { 'data-dscw-field': '' },
                  el(Input, {
                    type: 'password',
                    value: String(draft.batchApiKey ?? ''),
                    onChange: (e) => setPath('batchApiKey', e.target.value),
                    placeholder: 'sk-…',
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('batchApiKeyHint')),
                ),
                el('label', null, t('batchModel')),
                el(Input, {
                  value: String(draft.batchModel ?? ''),
                  onChange: (e) => setPath('batchModel', e.target.value),
                  placeholder: 'qwen3.7-flash',
                }),
                el('label', null, t('batchThinkingBudget')),
                el('div', { 'data-dscw-field': '' },
                  el(Input, {
                    value: String(draft.batchThinkingBudget ?? 0),
                    onChange: (e) => setPath('batchThinkingBudget', Number(e.target.value)),
                    placeholder: '0',
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('batchThinkingBudgetHint')),
                ),
                el('label', null, t('batchMinTokens')),
                el('div', { 'data-dscw-field': '' },
                  el(Input, {
                    value: String(draft.batchMinTokens ?? 0),
                    onChange: (e) => setPath('batchMinTokens', Number(e.target.value)),
                    placeholder: '30000',
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('batchMinTokensHint')),
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
                      if (lj) parts.push(`${kindLabelOf(t, lj.kind)} · ${stageLabel(lj.stage)}${lj.auto ? ` · ${t('autoTag')}` : ''}`)
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

          React.useEffect(() => {
            let alive = true
            let inFlight = false
            const pull = async () => {
              if (inFlight) return // 上次请求未回包（服务卡顿）时不重叠拉取
              inFlight = true
              try {
                const data = await apiGet(JOBS_PATH)
                if (!alive) return
                setJobs(Array.isArray(data.jobs) ? data.jobs : [])
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

          const kindLabel = (kind) => (t(`kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}`))

          const fmtElapsed = (ms) => {
            const s = Math.max(0, Math.floor(ms / 1000))
            const h = Math.floor(s / 3600)
            const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
            const ss = String(s % 60).padStart(2, '0')
            return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
          }
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
            const doneN = taskList.filter((x) => x.state === 'done').length
            const total = taskList.length || arts.length
            return el('div', { key: job.id, 'data-dscw-p-job': '', 'data-active': active ? 'true' : null },
              el('div', { 'data-dscw-p-row': '' },
                el(Tag, null, kindLabel(job.kind)),
                el('span', {
                  'data-dscw-p-stage': '', 'data-state': job.stage,
                  'data-running': active ? 'true' : null,
                }, stageLabel(job.stage)),
                active
                  ? el('span', { 'data-dscw-p-elapsed': '' },
                    `${t('elapsedLabel')} ${fmtElapsed(Date.now() - Date.parse(job.createdAt))}`)
                  : null,
                active
                  ? el(Button, {
                    variant: 'ghost', size: 'sm',
                    onClick: () => cancel(job.id),
                    disabled: busyId === job.id || job.cancelRequested === true,
                  }, job.cancelRequested === true ? t('cancelRequestedLabel') : t('cancelJob'))
                  : null,
              ),
              (typeof job.writtenCount === 'number' || arts.length || taskList.length)
                ? el('div', { 'data-dscw-p-meta': '' },
                  total
                    ? `${t('writtenLabel')} ${okCount}/${total} ${t('unitArticle')}`
                    : `${t('writtenLabel')} ${job.writtenCount ?? okCount} ${t('unitArticle')}`,
                  job.failedCount ? ` · ${t('failedLabel')} ${job.failedCount}` : '',
                  active && job.batchProgress ? ` · ${t('batchLabel')} ${job.batchProgress.completed}/${job.batchProgress.total}` : '',
                  job.tps ? ` · tps ${job.tps}` : '')
                : null,
              progressBar(
                active && job.batchProgress ? job.batchProgress.completed : doneN,
                active && job.batchProgress ? Math.max(job.batchProgress.total, taskList.length) : taskList.length,
              ),
              (job.notes ?? []).length
                ? el('div', { 'data-dscw-p-note': '' }, job.notes[job.notes.length - 1])
                : null,
              active && taskList.length
                ? el('div', { 'data-dscw-p-tasklist': '' },
                  taskList.map((x) => el('div', { key: x.name, 'data-dscw-p-task': '', 'data-state': x.state },
                    el('span', { 'data-mark': '' }, x.state === 'done' ? '✓' : x.state === 'failed' ? '✗' : '·'),
                    el('span', null, x.name))))
                : null,
              job.wikiPath
                ? el('div', { 'data-dscw-p-meta': '' }, `${t('wikiAt')}${job.wikiPath}`)
                : null,
            )
          }

          try {
            return el('div', { 'data-dscw-p-page': '' },
              el('div', { 'data-dscw-p-head': '' },
                el('h3', null, t('panelTitle')),
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
