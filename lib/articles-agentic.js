// agentic 文章执行器：把「模块任务清单」跑成文章。
//
// 与 index.js 里 runRealtimeTasks（单轮 prompt → 全文）并列的第二条执行通道：
//   - 单轮通道：把源码内联进 prompt，模型一次吐出全文，插件落盘。
//   - agentic 通道（本文件，吸收自 FSoft-AI4Code/CodeWiki 的 module agent）：
//     模型自己用 read_code/list_files 读源码、用 edit_article 增量写文章，
//     不再需要把源码整包塞进 prompt，因此没有「装填超预算 → 拆观察批 → 合成」这一整套。
//
// 失败语义与单轮通道一致：单任务失败只记账、不影响其它任务；返回 Map(customId → 结果)。
// 任何环节（缺 llm / 无 workspace / agentic 循环抛错）都抛或返回 ok:false，
// 由调用方决定是否整体降级到单轮通道。

import fs from 'node:fs'
import path from 'node:path'
import { runAgenticArticle, makeArticleEditor, DEFAULT_MAX_STEPS } from './agentic.js'
import { makeHostStream, makeFsWorkspace } from './agentic-host.js'

// 步数上限的唯一定义点在 lib/agentic.js（= 30）；这里再导出保持既有导入路径可用
// （index.js / 测试都从本模块拿），避免又出现一份独立常量。
export { DEFAULT_MAX_STEPS }

// 单篇跑一次 agentic 循环并落盘。
// 返回 { ok, stopReason, article, steps, usedTools, outputTokens, subModules }
//
// 子模块派发（对应上游 generate_sub_module_documentations.py）：
// 模型在写父模块时可以调 generate_sub_module 把「这部分其实该单独成文」拆出去。
// 这里就地递归跑一次 runOneArticle 写子模块文章，路径为
// `modules/<父 slug>/<子 slug>.md`——父子分开落盘，父文章不用先写死子文章内容。
// 递归深度封顶 subDepth（默认 2）：subDepth=0 完全不派发子模块，=1 只允许一层，
// 以此类推。判定点在本层 dispatchSub 的创建处（`_depth >= subDepth`），递归时把
// onSubModule 传 null，让子层按自己的 _depth 重建判定，深度才能逐层递增。
export async function runOneArticle(task, {
  llm, provider, model, reasoningEffort = '',
  language = '中文',
  cwd,
  fsImpl = fs,
  pathImpl = path,
  articleFormat = '',
  systemPrompt = '',
  maxSteps = DEFAULT_MAX_STEPS,
  signal = null,
  onDelta = null,
  onSubModule = null,
  subModuleBlocked = null,
  writeArticle = true,
  fixAnchors = null,
  streamFn: injectedStreamFn = null,
  subDepth = 2,
  _depth = 0,
  _takenNames = null,
} = {}) {
  const mission = String(task?.mission ?? `为模块「${task?.name ?? '模块'}」撰写文章`)
  // 已有旧文：作为初始内容交给 editor，模型用 str_replace 增量改，而不是从零重写
  let initialArticle = ''
  if (task?.prevArticlePath) {
    try { initialArticle = fsImpl.readFileSync(task.prevArticlePath, 'utf8') } catch { initialArticle = '' }
  }
  const editor = makeArticleEditor(initialArticle)
  const workspace = makeFsWorkspace(fsImpl, pathImpl, cwd ?? process.cwd())
  // streamFn 可注入（离线测试用假模型）；默认走宿主 llm
  const streamFn = injectedStreamFn ?? makeHostStream({ llm, provider, model, reasoningEffort, onDelta })

  // 子模块名全局唯一（上游 issue #76/#113 的教训：重名会互相覆盖文章）。
  // 同一次父任务内共享一份已用名集合；重名加父模块名前缀，仍重则跳过。
  const taken = _takenNames ?? new Set()
  const subModules = []
  const slugOf = (n) => String(n ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'module'
  // 父模块目录名取文章文件名（task.name 形如 modules/commerce.md，不是 slug 候选）
  const parentSlug = slugOf(pathImpl.basename(String(task?.name ?? 'module')).replace(/\.[^.]+$/, ''))

  // 深度封顶：onSubModule 传 null，同时用 subModuleBlocked='max-depth' 告诉工具层
  // 「是因为到顶了才不能派」——否则工具会笼统回「已记录/已派发」，模型据此在父文里
  // 写「详见 xxx.md」，那个文件从未生成，形成死链且父任务仍记 ok:true。
  const atMaxDepth = _depth >= subDepth
  const dispatchSub = atMaxDepth
    ? null
    : async ({ name, components, description }) => {
      let subName = String(name).trim()
      if (!subName) return { text: '子模块缺少名字，已忽略' }
      let slug = slugOf(subName)
      if (taken.has(slug)) {
        subName = `${task?.name ?? 'module'}/${subName}`
        slug = slugOf(subName)
      }
      if (taken.has(slug)) return { text: `子模块「${subName}」与已有文章重名，已跳过` }
      taken.add(slug)
      // 父文章在 <wiki>/modules/<父>.md，子模块落在同层的 <wiki>/modules/<父>/<子>.md
      const articlePath = pathImpl.join(pathImpl.dirname(task.articlePath), parentSlug, `${slug}.md`)
      const subTask = {
        name: `modules/${parentSlug}/${slug}.md`,
        mission: `为子模块「${subName}」撰写文章${description ? `：${description}` : ''}`,
        sources: components?.length ? components : (task?.sources ?? []),
        cwd,
        articlePath,
        prevArticlePath: articlePath,
      }
      const out = await runOneArticle(subTask, {
        llm, provider, model, reasoningEffort, language, cwd,
        fsImpl, pathImpl, articleFormat, systemPrompt,
        maxSteps, signal, onDelta: null,
        streamFn: injectedStreamFn,
        // 传 null 而不是 dispatchSub：dispatchSub 是**本层**的闭包，它的深度判定绑在
        // 本层的 `_depth` 上；原样下传会让子层永远用父层的深度判定（`_depth >= subDepth`
        // 恒不成立），subDepth 封顶形同虚设、模型可以无限往下拆。
        // 传 null 后子层自己构建 dispatchSub，绑定的是子层的 `_depth`（= _depth + 1）。
        onSubModule: null,
        subModuleBlocked: (_depth + 1) >= subDepth ? 'max-depth' : null,
        writeArticle, fixAnchors,
        subDepth, _depth: _depth + 1, _takenNames: taken,
      })
      subModules.push({ name: subName, path: articlePath, ok: out.ok !== false, stopReason: out.stopReason })
      return {
        text: out.ok === false
          ? `子模块「${subName}」写作失败（${out.stopReason}），父文章里应把它当作普通章节描述`
          : `子模块「${subName}」已单独成文：${pathImpl.relative(cwd ?? process.cwd(), articlePath).replace(/\\/g, '/')}`,
      }
    }

  const out = await runAgenticArticle({
    mission,
    streamFn,
    workspace,
    editor,
    onSubModule: onSubModule ?? dispatchSub,
    // 本层自己到顶时（dispatchSub 为 null）要把原因带下去，工具层才能说实话
    subModuleBlocked: onSubModule ? null : (subModuleBlocked ?? (atMaxDepth ? 'max-depth' : 'unsupported')),
    maxSteps,
    signal,
    systemPrompt,
    articleFormat,
  })

  // 模型全程没写过正文但最后一段文本像文章：runAgenticArticle 已经在无工具调用时收下它，
  // 这里只做兜底校验——空文章算失败，不能把空文件写下去覆盖旧文。
  const article = String(out.article ?? '')
  if (!article.trim()) {
    return { ...out, subModules, ok: false, stopReason: out.stopReason === 'finished' ? 'empty-article' : out.stopReason }
  }

  if (writeArticle && task?.articlePath) {
    let text = article
    if (typeof fixAnchors === 'function') {
      try {
        const fx = fixAnchors(article, cwd ?? null)
        text = fx?.text ?? article
      } catch { /* 锚点修正失败不影响落盘 */ }
    }
    fsImpl.mkdirSync(pathImpl.dirname(task.articlePath), { recursive: true })
    fsImpl.writeFileSync(task.articlePath, text, 'utf8')
  }
  return { ...out, subModules, ok: true }
}

// 模块源文本量（近似 token 数）：给 markBigAgenticTasks 当判据。
// 与 index.js estimateTokens 同一口径（CJK 按 1、其余按 3.5 字符/token），
// 这样大档预算（bigTokenBudget，单位是 token）可以直接比较。
// 读不到的文件按 0 计，不阻断——拿不到体量就不打大档，走默认档。
export function sourceTokensOf(task, cwd, { fsImpl = fs, pathImpl = path } = {}) {
  const est = (text) => {
    const s = String(text ?? '')
    let cjk = 0
    for (const ch of s) {
      const c = ch.codePointAt(0)
      if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) cjk++
    }
    return cjk + Math.ceil((s.length - cjk) / 3.5)
  }
  let total = 0
  for (const rel of task?.sources ?? []) {
    try {
      const abs = pathImpl.resolve(cwd ?? process.cwd(), rel)
      total += est(fsImpl.readFileSync(abs, 'utf8'))
    } catch { /* 读不到就跳过 */ }
  }
  return total
}

// 单任务的选档：任务自带 provider+model（大档任务，由 markBigAgenticTasks 打标）时
// 完全以任务为准，effort 也以任务为准（空 = 模型默认档）——不回落默认档的 effort，
// 因为默认档的 effort（如 off）可能不被大档模型支持。否则全用参数里的默认档。
export function resolveTaskRoute(task, { provider = '', model = '', reasoningEffort = '' } = {}) {
  const own = String(task?.provider ?? '').trim() && String(task?.model ?? '').trim()
  if (own) {
    return {
      provider: String(task.provider).trim(),
      model: String(task.model).trim(),
      reasoningEffort: String(task.reasoningEffort ?? '').trim(),
    }
  }
  return {
    provider: String(provider ?? '').trim(),
    model: String(model ?? '').trim(),
    reasoningEffort: String(reasoningEffort ?? '').trim(),
  }
}

// 并发池：与 runRealtimeTasks 同形状（Map(customId → 结果)），但每个任务跑的是 agentic 循环。
// onRequestStart(task) 可选：返回 { onDelta } 之类的记录器钩子。
//
// 双池（与 runRealtimeTasks 一致）：带 bigTier 标记的任务走大档池（bigConcurrency），
// 其余走默认档池（concurrency）。两池各自独立限流、同时推进——大档常是付费长上下文，
// 与免费默认档配额互不相干。bigConcurrency 为 0/未传时回落到 concurrency。
// 单任务可选自带 provider/model/reasoningEffort（大档任务），缺省用参数里的默认档。
export async function runAgenticArticles(tasks, {
  concurrency = 2,
  bigConcurrency = 0,
  notes = [],
  signal = null,
  onTaskDone = null,
  onRequestStart = null,
  ...rest
} = {}) {
  const results = new Map()
  const list = Array.isArray(tasks) ? tasks : []
  if (!list.length) return results

  const pools = []
  const normalTasks = list.filter((t) => t?.bigTier !== true)
  const bigTasks = list.filter((t) => t?.bigTier === true)
  if (normalTasks.length) {
    pools.push({ tasks: normalTasks, limit: Math.max(1, Math.min(Number(concurrency) || 1, normalTasks.length)) })
  }
  if (bigTasks.length) {
    const bigLimit = Number.isFinite(Number(bigConcurrency)) && Number(bigConcurrency) >= 1
      ? Number(bigConcurrency)
      : (Number(concurrency) || 1)
    pools.push({ tasks: bigTasks, limit: Math.max(1, Math.min(bigLimit, bigTasks.length)) })
  }

  const runPool = async (pool) => {
    let cursor = 0
    const worker = async () => {
      for (;;) {
        if (signal?.aborted) return
        const i = cursor++
        if (i >= pool.tasks.length) return
        const t = pool.tasks[i]
        const rec = onRequestStart ? onRequestStart(t) : null
        const startedAt = Date.now()
        try {
          const route = resolveTaskRoute(t, rest)
          const out = await runOneArticle(t, {
            ...rest,
            provider: route.provider,
            model: route.model,
            reasoningEffort: route.reasoningEffort,
            signal,
            onDelta: rec?.onDelta ?? null,
          })
          // outputTokens 由 streamFn 侧收不到（chunk 里 usage 会出现多次），这里按步数粗估
          const outputTokens = Number(out?.usage?.outputTokens) || 0
          if (onTaskDone) onTaskDone({ outputTokens, durationMs: Date.now() - startedAt })
          const subs = Array.isArray(out?.subModules) ? out.subModules : []
          if (subs.length) {
            notes.push(`${t.name} 派生出 ${subs.length} 个子模块文章：${subs.map((s) => s.name).join('、')}`)
          }
          results.set(t.customId, {
            name: t.name,
            ok: out.ok !== false,
            stopReason: out.stopReason,
            steps: out.steps?.length ?? 0,
            tools: out.usedTools ?? [],
            subModules: subs.map((s) => ({ name: s.name, path: s.path, ok: s.ok })),
          })
          if (out.ok === false) notes.push(`${t.name} agentic 写作未产出正文（${out.stopReason}）`)
          rec?.onDone?.(String(out.article ?? ''), outputTokens)
        } catch (err) {
          notes.push(`${t.name} agentic 请求失败 —— ${String(err?.message ?? err)}`)
          results.set(t.customId, { name: t.name, ok: false, stopReason: 'error' })
          rec?.onError?.(err)
        }
      }
    }
    await Promise.all(Array.from({ length: pool.limit }, worker))
  }

  await Promise.all(pools.map(runPool))
  return results
}

// 按体量给 agentic 任务打大档标记（纯逻辑，与 index.js prepareArticleTasks 的 markBig 同语义：
// 打标记 = 把大档的 provider/model/reasoningEffort 写到任务上）。
// agentic 通道不装填源码（模型自己读），所以单轮通道那条「装填超预算」判据不适用；
// 这里用等价物：模块源文本量超过 budget 就当大档任务——模块大到一个普通上下文模型读不完，
// 交给大上下文档写更稳。读源码仍是按需，不会整包内联。
// bigTier = { provider, model, reasoningEffort?, budget }；未配置（无 provider）时原样返回。
export function markBigAgenticTasks(tasks, { bigTier = null, sizeOf = null } = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  const tier = bigTier && String(bigTier.provider ?? '').trim() ? bigTier : null
  if (!tier) return list
  const limit = Number(tier.budget) || 0
  if (!limit) return list
  return list.map((t) => {
    const size = sizeOf ? Number(sizeOf(t)) || 0 : Number(t?.sourceChars ?? 0) || 0
    if (size <= limit) return t
    const out = { ...t, provider: tier.provider, model: tier.model, bigTier: true }
    if (tier.reasoningEffort) out.reasoningEffort = tier.reasoningEffort
    return out
  })
}
