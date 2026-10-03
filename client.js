// dsh-codewiki — 客户端半侧（浏览器）v0.2.0
// 在「插件」页 Official 组注册 `plugins.item`（id = codewiki，与 profile patch 条目一致）：
// 列表出现 CodeWiki 条目，点击进入详情页即可设定编译模型等选项。
// 协议参照 ui-plugin-manager slot-contract 与 ui-settings-agent-loop（view: 'summary' | 'page'）；
// 配置读写经 configForms（宿主半侧 Config 全 volatile → 命名空间 'codewiki'）；
// 模型目录经 ctx.remote.session.modelCatalog()，响应形状 { ok, value: { groups, failures } }。
// id 必须等于 package.json 的 name（client-modules 按 nearestPackage 的 name 校验注册者）；
// 词典值必须是字符串——词典值若为函数，t() 会回退返回键名。

window.__ModuleLoader__.load({
  id: '@local/dsh-codewiki',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Switch, Button, Input, Pill, StateDot, Tag } = primitives

    const NS = 'codewiki' // profile patch 条目 id = 设置命名空间

    const zh = () => ({
      title: 'CodeWiki',
      summary: '随仓库的代码 wiki（<repo>/.codewiki/）：cw CLI 与智能体编排编译，可指定编译模型。',
      intro: '维护各仓库 .codewiki/ 目录下的活 wiki（随仓库提交共享）。此处设置经 configForms 热生效，无需重启。',
      secModel: '编译模型',
      secModelHint: 'codewiki_generate 派发的写文章/横切/审校子代理所用模型；provider 与 model 成对生效。',
      inheritHint: '两项都留空 = 跟随当前会话模型。默认钉在路由插件 wiki 档（aliyun-bailian / qwen3.8-flash）。',
      provider: 'Provider',
      model: 'Model',
      selectPrompt: '（未设置）',
      catalogReady: '模型目录已就绪',
      catalogPartial: '模型目录部分可用',
      catalogLoading: '模型目录加载中…',
      catalogError: '模型目录不可用 · 重试',
      secRun: '运行',
      enabled: '启用插件',
      enabledHint: '停用后 cw 与 codewiki_generate 两个工具立即报错。',
      updateReminder: 'wiki 维护提醒',
      updateReminderHint: '会话系统提示注入收尾提醒：仅当会话仓库存在 .codewiki/ 时出现，提醒改完代码后更新 wiki。',
      reasoningEffort: '思考程度',
      reasoningEffortHint: '子代理思考程度（reasoningEffort）。下拉来自模型目录对当前 provider+model 广播的档位；留空或目录不可用时跟随所选模型默认，也可手输 adapter 自有值。',
      maxConcurrency: '写文章并发上限',
      maxConcurrencyHint: '1–8；硬顶 8。',
      secBatch: '批量推理（降本）',
      secBatchHint: '写文章环节改走阿里云百炼批量推理（Batch File，实时价 50%）；规划/横切/审校仍走智能体子代理。仅华北2（北京）支持，模型须用别名（快照版不支持批量）。',
      batchEnabled: '启用批量推理',
      batchEnabledHint: '开启且找到百炼凭证时写文章走批量——凭证自动取模型设置「阿里百炼云」渠道；取不到才回退智能体子代理。',
      batchApiKey: '百炼 API Key',
      batchApiKeyHint: 'DashScope API Key（sk-…）。留空时自动使用模型设置「阿里百炼云」渠道的凭证；此处填写则覆盖它。',
      batchModel: '批量模型',
      batchModelHint: '默认 qwen3.7-flash；仅华北2 支持，须用别名（快照版如 qwen3.7-flash-2026-07-15 不支持批量）。',
      batchThinkingBudget: '批量思考预算',
      batchThinkingBudgetHint: '0=关思考（最省，推荐简单任务）；1–32768=开思考并限预算（轻推理 1024，复杂 4096–8192）。思考 Token 计入输出计费。',
      batchWaitMinutes: '就地等待（分钟）',
      batchWaitMinutesHint: '批量任务就地轮询等待时长；超时保留断点，下次 codewiki_generate 自动续查收尾。',
      invalidBatchThinking: '批量思考预算须为 0–32768 的整数。',
      invalidBatchWait: '就地等待须为正整数分钟。',
      articleLanguage: '文章语言',
      binaryPath: 'cw 可执行路径',
      binaryPathHint: '留空优先用 PATH 里的 cw（与 codewiki 源码同步），找不到再用插件自带 bin/cw.exe。',
      save: '保存',
      discard: '放弃更改',
      saved: '已保存。',
      conflict: '保存冲突：设置已被他处修改，请重试。',
      invalidConcurrency: '并发上限须为 1–8 的整数。',
      overridden: '已被配置文件覆盖',
      reset: '重置',
    })
    const en = () => ({
      title: 'CodeWiki',
      summary: 'Repo-local code wiki (<repo>/.codewiki/): cw CLI and agent-orchestrated compilation with model routing.',
      intro: 'Maintains a living wiki inside each repository at .codewiki/ (committed and shared with the repo). Settings here apply hot via configForms — no restart needed.',
      secModel: 'Compilation model',
      secModelHint: 'Model used by the writer/cross-cut/review subagents spawned by codewiki_generate; provider and model take effect as a pair.',
      inheritHint: 'Leave both empty to follow the session model. Defaults pin the router wiki tier (aliyun-bailian / qwen3.8-flash).',
      provider: 'Provider',
      model: 'Model',
      selectPrompt: '(unset)',
      catalogReady: 'Model catalog ready',
      catalogPartial: 'Model catalog partially available',
      catalogLoading: 'Loading model catalog…',
      catalogError: 'Model catalog unavailable · retry',
      secRun: 'Runtime',
      enabled: 'Enable plugin',
      enabledHint: 'When off, the cw and codewiki_generate tools error immediately.',
      updateReminder: 'Wiki update reminder',
      updateReminderHint: 'Injects a wrap-up reminder into the session system prompt — only when the session repo has a .codewiki/.',
      reasoningEffort: 'Reasoning effort',
      reasoningEffortHint: 'Subagent reasoning effort. Options come from the model catalog for the current provider+model; empty or catalog-unavailable follows the selected model default. Custom adapter values can be typed in.',
      maxConcurrency: 'Writer concurrency cap',
      maxConcurrencyHint: '1–8; hard cap 8.',
      secBatch: 'Batch inference (cost saving)',
      secBatchHint: 'Routes article writing through Alibaba Cloud Bailian batch inference (Batch File, 50% of realtime price); planning/cross-cut/review stay on agent subagents. North China 2 (Beijing) only; use the model alias (snapshots do not support batch).',
      batchEnabled: 'Enable batch inference',
      batchEnabledHint: 'When on with a Bailian credential found — the "阿里百炼云" provider credential from model settings is used automatically — article writing goes through batch; otherwise it falls back to agent subagents.',
      batchApiKey: 'Bailian API key',
      batchApiKeyHint: 'DashScope API key (sk-…). Leave empty to reuse the credential of the "阿里百炼云" provider from model settings; a value here overrides it.',
      batchModel: 'Batch model',
      batchModelHint: 'Default qwen3.7-flash; North China 2 only, alias required (e.g. the qwen3.7-flash-2026-07-15 snapshot does not support batch).',
      batchThinkingBudget: 'Batch thinking budget',
      batchThinkingBudgetHint: '0 = thinking off (cheapest, recommended for simple tasks); 1–32768 = thinking on with a budget (1024 light, 4096–8192 complex). Thinking tokens bill as output.',
      batchWaitMinutes: 'Inline wait (minutes)',
      batchWaitMinutesHint: 'How long to poll the batch task inline; on timeout a breakpoint is kept and the next codewiki_generate call settles it automatically.',
      invalidBatchThinking: 'Batch thinking budget must be an integer between 0 and 32768.',
      invalidBatchWait: 'Inline wait must be a positive integer number of minutes.',
      articleLanguage: 'Article language',
      binaryPath: 'cw binary path',
      binaryPathHint: 'Empty = cw on PATH first (kept in sync with the codewiki source), bundled bin/cw.exe as fallback.',
      save: 'Save',
      discard: 'Discard changes',
      saved: 'Saved.',
      conflict: 'Save conflict: settings changed elsewhere, please retry.',
      invalidConcurrency: 'Concurrency cap must be an integer between 1 and 8.',
      overridden: 'Overridden by config file',
      reset: 'Reset',
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
      '[data-dscw-grid] select { font: inherit; font-size: 13px; width: 100%; box-sizing: border-box; height: 32px; padding: 0 10px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; color: inherit; }',
      '[data-dscw-field] { display: flex; flex-direction: column; gap: 4px; }',
      '[data-dscw-bar] { display: flex; align-items: center; gap: 8px; padding: 10px 0 0; border-top: 0.5px solid var(--dsw-alias-border-l3); }',
      '[data-dscw-notice] { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
      '[data-dscw-warn] { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary)); font-size: 12px; line-height: 18px; }',
    ].join('\n')
    document.head.appendChild(style)

    function el(tag, props, ...children) {
      return React.createElement(tag, props, ...children)
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.session', 'configForms'],
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

        // -------------------------------------------------------------------
        // 设置卡片组件（view='summary' 一行简介；view='page' 完整表单）
        // -------------------------------------------------------------------

        function CodewikiCard(props) {
          const t = props?.t ?? tBound

          const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
          const [draft, setDraft] = React.useState(null)
          const [notice, setNotice] = React.useState(null)
          const [error, setError] = React.useState(null)
          const [catalog, setCatalog] = React.useState(null) // { groups, partial }
          const [catalogStatus, setCatalogStatus] = React.useState('idle') // idle|loading|ready|error
          const genRef = React.useRef(0)
          const retryRef = React.useRef(0)

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

          // 模型目录：失败退避重试；适配器/设置变更与连接重置时刷新。
          const refreshCatalog = React.useCallback(async () => {
            const gen = ++genRef.current
            setCatalogStatus('loading')
            try {
              const session = ctx.remote?.session
              if (!session?.modelCatalog) { setCatalog(null); setCatalogStatus('error'); return }
              const response = await session.modelCatalog()
              if (gen !== genRef.current) return
              const value = response && response.ok ? response.value : null
              if (value && Array.isArray(value.groups) && value.groups.length > 0) {
                setCatalog({ groups: value.groups, partial: (value.failures ?? []).length > 0 })
                setCatalogStatus('ready')
                retryRef.current = 0
              } else {
                setCatalog(null)
                setCatalogStatus('error')
                console.warn('[dsh-codewiki] modelCatalog 未返回可用目录', response)
              }
            } catch (err) {
              if (gen === genRef.current) { setCatalog(null); setCatalogStatus('error') }
              console.warn('[dsh-codewiki] modelCatalog 调用失败', err)
            }
          }, [])

          React.useEffect(() => { refreshCatalog() }, [refreshCatalog])
          React.useEffect(() => {
            if (catalogStatus !== 'error' || retryRef.current >= 3) return
            const id = setTimeout(() => { retryRef.current += 1; refreshCatalog() }, 4000)
            return () => clearTimeout(id)
          }, [catalogStatus, refreshCatalog])
          ctx.effect(() => ctx.remote?.$on?.('llm/adapters-updated', refreshCatalog), 'dscw: adapters invalidation')
          ctx.effect(() => ctx.on?.('connection/reset', () => {
            genRef.current += 1
            setCatalog(null)
            setCatalogStatus('idle')
            refreshCatalog()
          }), 'dscw: connection reset')

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
            const waitMin = Number(draft?.batchWaitMinutes)
            if (Number.isFinite(waitMin) && (waitMin < 1 || !Number.isInteger(waitMin))) {
              setError(t('invalidBatchWait'))
              return
            }
            const base = snapshot.value ?? {}
            const ops = []
            for (const key of ['enabled', 'binaryPath', 'defaultProvider', 'defaultModel', 'defaultReasoningEffort', 'maxConcurrency', 'articleLanguage', 'updateReminder', 'batchEnabled', 'batchApiKey', 'batchModel', 'batchThinkingBudget', 'batchWaitMinutes']) {
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

          // 模型目录 → provider/model 级联下拉；目录不可用或自定义 id 时退回文本输入。
          const groups = catalog?.groups ?? []
          const providers = groups.map((g) => ({ id: g.id, label: g.name || g.id }))
          const modelsOf = (providerId) => (groups.find((g) => g.id === providerId)?.models ?? [])
            .map((m) => ({ id: m.id, label: m.name || m.id }))
          const selectOptions = (list, current) => {
            const head = !current
              ? [el('option', { key: '__none', value: '' }, t('selectPrompt'))]
              : list.some((x) => x.id === current)
                ? []
                : [el('option', { key: '__keep', value: current }, current)]
            return head.concat(list.map((x) => el('option', { key: x.id, value: x.id }, x.label)))
          }
          const providerCell = (current) => providers.length
            ? el('select', { value: current ?? '', onChange: (e) => { setPath('defaultProvider', e.target.value) } },
              selectOptions(providers, current))
            : el(Input, { value: current ?? '', onChange: (e) => setPath('defaultProvider', e.target.value), placeholder: 'aliyun-bailian' })
          const modelCell = (providerId, current) => {
            const models = modelsOf(providerId)
            if (!models.length) {
              return el(Input, { value: current ?? '', onChange: (e) => setPath('defaultModel', e.target.value), placeholder: 'qwen3.8-flash' })
            }
            return el('select', { value: current ?? '', onChange: (e) => setPath('defaultModel', e.target.value) },
              selectOptions(models, current))
          }
          // 思考程度：档位来自模型目录对当前 provider+model 广播的 efforts（adapter 自有值，不硬编码枚举）。
          // 目录没有该模型或无 efforts 时退回文本输入；当前值不在档位里时 selectOptions 会用 __keep 保留显示。
          const effortCell = (providerId, modelId, current) => {
            const efforts = (groups.find((g) => g.id === providerId)?.models ?? [])
              .find((m) => m.id === modelId)?.reasoning?.efforts ?? []
            const options = efforts.map((e2) => ({ id: e2.id, label: e2.name || e2.id }))
            if (!options.length) {
              return el(Input, { value: current ?? '', onChange: (e) => setPath('defaultReasoningEffort', e.target.value), placeholder: 'off/low/high/max…' })
            }
            return el('select', { value: current ?? '', onChange: (e) => setPath('defaultReasoningEffort', e.target.value) },
              selectOptions(options, current))
          }

          const statusPill = catalogStatus === 'loading'
            ? el(Pill, null, el(StateDot, { state: 'ongoing' }), ' ', t('catalogLoading'))
            : catalogStatus === 'ready'
              ? el(Pill, null, el(StateDot, { state: catalog.partial ? 'warning' : 'done' }), ' ',
                catalog.partial ? t('catalogPartial') : t('catalogReady'))
              : catalogStatus === 'error'
                ? el(Pill, { onClick: refreshCatalog }, el(StateDot, { state: 'error' }), ' ', t('catalogError'))
                : null

          if (snapshot.status === 'loading' || snapshot.status === 'unavailable' || !draft) {
            return el('div', { 'data-dscw-page': '' }, el('div', { 'data-dscw-notice': '' }, t('catalogLoading')))
          }

          return el('div', { 'data-dscw-page': '' },
            el('div', { 'data-dscw-hint': '' }, t('intro')),
            // 编译模型
            el('section', { 'data-dscw-field': '' },
              el('div', { 'data-dscw-head': '' },
                el('h4', null, t('secModel')),
                statusPill,
              ),
              el('div', { 'data-dscw-hint': '' }, t('secModelHint')),
              el('div', { 'data-dscw-grid': '' },
                el('label', null, t('provider')),
                providerCell(draft.defaultProvider),
                el('label', null, t('model')),
                modelCell(draft.defaultProvider, draft.defaultModel),
                el('label', null, t('reasoningEffort')),
                effortCell(draft.defaultProvider, draft.defaultModel, draft.defaultReasoningEffort),
              ),
              el('div', { 'data-dscw-hint': '' }, t('inheritHint')),
              el('div', { 'data-dscw-hint': '' }, t('reasoningEffortHint')),
            ),
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
            // 批量推理（降本）
            el('section', { 'data-dscw-field': '' },
              el('div', { 'data-dscw-head': '' }, el('h4', null, t('secBatch'))),
              el('div', { 'data-dscw-hint': '' }, t('secBatchHint')),
              el('div', { 'data-dscw-grid': '' },
                el('label', null, t('batchEnabled')),
                el('div', { 'data-dscw-field': '' },
                  el(Switch, {
                    checked: draft.batchEnabled === true,
                    onChange: (v) => setPath('batchEnabled', v),
                    label: t('batchEnabled'),
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('batchEnabledHint')),
                ),
                el('label', null, t('batchApiKey')),
                el('div', { 'data-dscw-field': '' },
                  el(Input, {
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
                el('label', null, t('batchWaitMinutes')),
                el('div', { 'data-dscw-field': '' },
                  el(Input, {
                    value: String(draft.batchWaitMinutes ?? 20),
                    onChange: (e) => setPath('batchWaitMinutes', Number(e.target.value)),
                    placeholder: '20',
                  }),
                  el('div', { 'data-dscw-hint': '' }, t('batchWaitMinutesHint')),
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
      },
    }
  },
})
