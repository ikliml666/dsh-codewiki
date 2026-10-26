// Agentic 文章写作 —— 对应 FSoft-AI4Code/CodeWiki 的 src/be/agent_tools/
//   read_code_components.py      —— 按组件 id 取源码（可带行范围）
//   str_replace_editor.py        —— 对文章做精确字符串替换 / 插入 / 查看
//   generate_sub_module_documentations.py —— 为子模块递归派发写作任务
// 以及 documentation_generator.py 里的 pydantic-ai 工具循环（run_module_agent）。
//
// 上游的价值主张：不是「把所有源码塞进一次 prompt 求一篇文章」，而是给模型
// 一个可反复读代码、可对文章做精确编辑、可把大模块拆给子任务的工作台——
// 于是行号/签名这类硬事实可以现场核对，而不是靠一次性读进上下文后猜。
//
// 本模块的差异：
//   - 工具循环写成纯逻辑 + 注入 streamFn/工具实现，不绑死 pydantic-ai，
//     也不绑死宿主的 llm 服务（测试可完全离线）。
//   - 上游工具读写的是 pydantic-ai 的 RunContext；这里的 workspace 是一个
//     {readFile, writeFile, readdir} 抽象，便于在插件里接到任何 cwd。
//
// 契约：
//   runAgenticArticle({ mission, workspace, streamFn, tools?, maxSteps })
//     -> { article, steps: [...], usedTools: [...], stopReason }

import path from 'node:path'

// ---------------------------------------------------------------------------
// 工具定义（JSON Schema 形态，对应宿主 ToolSchema）
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS = [
  {
    name: 'read_code',
    description:
      '读取仓库中一个文件的源码，或只读其中某段行范围。行号以返回的「行号| 」前缀为准，'
      + '引用代码位置时必须用这个行号，禁止自行推算。写作前先读你打算引用的每个文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库相对路径，POSIX 风格，如 src/index.js' },
        start_line: { type: 'integer', description: '起始行（1 起，含）；省略则从文件头开始' },
        end_line: { type: 'integer', description: '结束行（含）；省略则读到文件尾' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: '列出某目录下的文件与子目录（POSIX 相对路径）。用于搞清仓库里到底有哪些文件、该读哪些。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库相对目录路径；省略表示仓库根' },
        depth: { type: 'integer', description: '递归深度，默认 1（只看这一层）' },
      },
    },
  },
  {
    name: 'edit_article',
    description:
      '对当前正在写的文章执行精确编辑。三种命令：'
      + 'view=查看当前全文；str_replace=把 old_str 替换成 new_str（old_str 必须唯一匹配）；'
      + 'insert=在第 line 行后插入 text。文章一开始为空，用 insert 从第 0 行开始搭骨架，再用 str_replace 逐段填实。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['view', 'str_replace', 'insert'], description: '编辑命令' },
        old_str: { type: 'string', description: 'str_replace 要被替换的原文（必须唯一出现）' },
        new_str: { type: 'string', description: 'str_replace 替换后的文本' },
        line: { type: 'integer', description: 'insert 的插入位置（在这一行之后插入，0 表示文件开头）' },
        text: { type: 'string', description: 'insert 要插入的文本' },
      },
      required: ['command'],
    },
  },
  {
    name: 'generate_sub_module',
    description:
      '把当前模块的某个子模块委派出去单独写作（会生成独立的子模块文章）。'
      + '仅当模块内确实存在可独立成篇的子部分时使用；调用后本模块文章里应留下指向该子模块的说明。',
    parameters: {
      type: 'object',
      properties: {
        module_name: { type: 'string', description: '子模块名（英文小写下划线）' },
        components: { type: 'array', items: { type: 'string' }, description: '该子模块包含的组件 id 清单' },
        description: { type: 'string', description: '子模块职责与边界，写给负责该子模块的写作者' },
      },
      required: ['module_name', 'description'],
    },
  },
]

// ---------------------------------------------------------------------------
// 工具实现：全部是纯函数式，靠 workspace 抽象访问真实仓库
// ---------------------------------------------------------------------------

const MAX_READ_LINES = 2000

// 与插件其余环节一致的行号前缀格式，模型据此引用行号
export function numberLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line, i) => `${i + 1}| ${line}`)
    .join('\n')
}

export function makeReadCodeTool(workspace) {
  return async (args) => {
    const rel = String(args?.path ?? '').trim()
    if (!rel) return { isError: true, text: 'read_code 缺少 path 参数' }
    const safe = safeRelPath(rel)
    if (safe === null) return { isError: true, text: `read_code 拒绝越界路径：${rel}` }
    let text
    try {
      text = await workspace.readFile(safe)
    } catch (err) {
      return { isError: true, text: `读取失败：${safe}（${String(err?.message ?? err)}）` }
    }
    const lines = String(text).split('\n')
    const start = Math.max(1, Number(args?.start_line) || 1)
    const endArg = Number(args?.end_line)
    const end = Number.isFinite(endArg) && endArg > 0 ? Math.min(lines.length, endArg) : lines.length
    if (start > lines.length) {
      return { isError: true, text: `起止行超出文件长度：${safe} 共 ${lines.length} 行` }
    }
    let slice = lines.slice(start - 1, end)
    let truncated = false
    if (slice.length > MAX_READ_LINES) {
      slice = slice.slice(0, MAX_READ_LINES)
      truncated = true
    }
    const body = slice.map((l, i) => `${start + i}| ${l}`).join('\n')
    return {
      isError: false,
      text: `${safe}（第 ${start}–${start + slice.length - 1} 行，共 ${lines.length} 行）`
        + `${truncated ? `\n（超出 ${MAX_READ_LINES} 行上限，仅返回前 ${MAX_READ_LINES} 行；请用行范围继续读）` : ''}\n\n${body}`,
    }
  }
}

export function makeListFilesTool(workspace) {
  return async (args) => {
    const rel = safeRelPath(String(args?.path ?? '').trim() || '.')
    if (rel === null) return { isError: true, text: 'list_files 拒绝越界路径' }
    const depth = Math.min(4, Math.max(1, Number(args?.depth) || 1))
    let entries
    try {
      entries = await workspace.listDir(rel, depth)
    } catch (err) {
      return { isError: true, text: `列目录失败：${rel}（${String(err?.message ?? err)}）` }
    }
    if (!entries.length) return { isError: false, text: `${rel} 下没有文件` }
    return { isError: false, text: entries.map((e) => (e.dir ? `${e.path}/` : e.path)).join('\n') }
  }
}

// 文章编辑工具：状态就在闭包里，模型每次 add/insert/replace 都改这一份
export function makeArticleEditor(initial = '') {
  let article = String(initial ?? '')
  const edit = async (args) => {
    const cmd = String(args?.command ?? '').trim()
    if (cmd === 'view') {
      if (!article.trim()) return { isError: false, text: '（文章当前为空）' }
      return { isError: false, text: numberLines(article) }
    }
    if (cmd === 'str_replace') {
      const oldStr = String(args?.old_str ?? '')
      const newStr = String(args?.new_str ?? '')
      if (!oldStr) return { isError: true, text: 'str_replace 缺少 old_str' }
      const first = article.indexOf(oldStr)
      if (first < 0) return { isError: true, text: `str_replace 未找到待替换文本（长度 ${oldStr.length}）：请先 view 确认原文逐字一致` }
      const second = article.indexOf(oldStr, first + 1)
      if (second >= 0) {
        return { isError: true, text: 'str_replace 的 old_str 在文章中出现了多次，不唯一：请带上更多上下文使其唯一' }
      }
      article = article.slice(0, first) + newStr + article.slice(first + oldStr.length)
      return { isError: false, text: `已替换（文章现长 ${article.length} 字符）` }
    }
    if (cmd === 'insert') {
      const line = Math.max(0, Number(args?.line) || 0)
      const text = String(args?.text ?? '')
      if (!text) return { isError: true, text: 'insert 缺少 text' }
      // 空文章 split 出来是 ['']，把它当零行，否则每次插入都会多出一个空行
      const lines = article === '' ? [] : article.split('\n')
      if (line > lines.length) {
        return { isError: true, text: `insert 位置 ${line} 超出文章长度（当前 ${lines.length} 行）` }
      }
      // line=0 表示插到最前；否则插到第 line 行之后
      const head = line === 0 ? [] : lines.slice(0, line)
      const tail = line === 0 ? lines : lines.slice(line)
      article = [...head, text, ...tail].join('\n')
      return { isError: false, text: `已插入（文章现长 ${article.split('\n').length} 行）` }
    }
    return { isError: true, text: `未知 command：${cmd}（可选 view / str_replace / insert）` }
  }
  return {
    edit,
    get article() { return article },
    set article(v) { article = String(v ?? '') },
  }
}

// 路径越界防护：不允许 ../ 跳出去
export function safeRelPath(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/').trim()
  if (!s) return null
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null
  const norm = path.posix.normalize(s)
  if (norm.startsWith('..') || norm.includes('/../')) return null
  return norm
}

// ---------------------------------------------------------------------------
// 工具调度表
// ---------------------------------------------------------------------------

export function buildToolset({ workspace, editor, onSubModule }) {
  return {
    read_code: makeReadCodeTool(workspace),
    list_files: makeListFilesTool(workspace),
    edit_article: editor.edit,
    generate_sub_module: async (args) => {
      const name = String(args?.module_name ?? '').trim()
      if (!name) return { isError: true, text: 'generate_sub_module 缺少 module_name' }
      const ids = Array.isArray(args?.components) ? args.components.map(String) : []
      const desc = String(args?.description ?? '').trim()
      if (!onSubModule) {
        return { isError: false, text: `已记录子模块 ${name}（本模式下不递归成文）：${desc}` }
      }
      try {
        const res = await onSubModule({ name, components: ids, description: desc })
        return { isError: false, text: res?.text ?? `子模块 ${name} 已派发` }
      } catch (err) {
        return { isError: true, text: `子模块 ${name} 派发失败：${String(err?.message ?? err)}` }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 循环本体
// ---------------------------------------------------------------------------

const DEFAULT_MAX_STEPS = 24

// 单步请求：调 streamFn 拿回一条 assistant 消息的 blocks
// streamFn({ messages, tools, signal }) -> { blocks: ContentBlock[], finish }
// 这类细节由插件侧适配（见 index.js 的 agenticStream），本模块只消费 blocks。

export async function runAgenticArticle(opts) {
  const {
    mission,
    streamFn,
    workspace,
    tools: extraTools = {},
    editor: existingEditor,
    onSubModule = null,
    maxSteps = DEFAULT_MAX_STEPS,
    signal = null,
    initialMessages = null,
    systemPrompt = '',
    articleFormat = '',
  } = opts

  if (typeof streamFn !== 'function') throw new Error('runAgenticArticle 需要 streamFn')
  const editor = existingEditor ?? makeArticleEditor(opts.initialArticle ?? '')
  const tools = { ...buildToolset({ workspace, editor, onSubModule }), ...extraTools }

  // 只把实际可用的工具声明给模型（比如没有 workspace 就不声明 read_code）
  const schemas = TOOL_SCHEMAS.filter((t) => typeof tools[t.name] === 'function')

  const messages = initialMessages ?? [
    {
      role: 'user',
      content: [{ type: 'text', text: buildOpeningPrompt({ mission, systemPrompt, articleFormat, schemas }) }],
    },
  ]

  const steps = []
  const usedTools = new Set()
  let stopReason = 'max-steps'

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) { stopReason = 'aborted'; break }

    let blocks
    try {
      const out = await streamFn({ messages, tools: schemas, signal })
      blocks = Array.isArray(out) ? out : (out?.blocks ?? [])
    } catch (err) {
      steps.push({ step, error: String(err?.message ?? err) })
      stopReason = 'stream-error'
      break
    }
    if (!blocks?.length) { stopReason = 'empty-response'; break }

    // 模型消息原样进历史（含它自己发出的 tool-call），否则下一轮对不上 callId
    messages.push({ role: 'assistant', content: blocks })

    const calls = blocks.filter((b) => b.type === 'tool-call')
    const textBlocks = blocks.filter((b) => b.type === 'text')
    const textOut = textBlocks.map((b) => b.text).join('')

    if (!calls.length) {
      // 没有工具调用 = 模型认为写完了。若它同时在正文里给了文章、而 editor 还空，收下正文。
      if (!editor.article.trim() && textOut.trim()) editor.article = textOut.trim()
      steps.push({ step, text: textOut.slice(0, 200), toolCalls: 0 })
      stopReason = 'finished'
      break
    }

    // 执行工具调用，结果作为 tool-result 消息回灌
    const results = []
    for (const call of calls) {
      usedTools.add(call.name)
      const args = parseToolArgs(call.arguments, steps, step, call.name)
      const impl = tools[call.name]
      let outcome
      if (!impl) {
        outcome = { isError: true, text: `未知工具：${call.name}（可用：${Object.keys(tools).join('、')}）` }
      } else {
        try {
          outcome = await impl(args)
        } catch (err) {
          outcome = { isError: true, text: `工具执行抛错：${String(err?.message ?? err)}` }
        }
      }
      results.push({
        type: 'tool-result',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: String(outcome?.text ?? '') }],
        isError: !!outcome?.isError,
      })
    }
    messages.push({ role: 'tool', content: results })
    steps.push({ step, text: textOut.slice(0, 120), toolCalls: calls.length, tools: calls.map((c) => c.name) })
  }

  return {
    article: editor.article,
    steps,
    usedTools: [...usedTools],
    stopReason,
    messages,
  }
}

// 模型偶尔会给出坏 JSON：不中断，把错误当成工具结果回灌让它自己改
export function parseToolArgs(raw, steps, step, toolName) {
  if (raw && typeof raw === 'object') return raw
  const s = String(raw ?? '').trim()
  if (!s) return {}
  try {
    return JSON.parse(s)
  } catch (err) {
    steps.push({ step, warning: `工具 ${toolName} 参数不是合法 JSON：${String(err?.message ?? err)}`, raw: s.slice(0, 200) })
    return {}
  }
}

// ---------------------------------------------------------------------------
// 开场提示词
// ---------------------------------------------------------------------------

export function buildOpeningPrompt({ mission, systemPrompt = '', articleFormat = '', schemas = [] }) {
  const toolList = schemas.map((t) => `- ${t.name}：${t.description.split('\n')[0]}`).join('\n')
  const hasSub = schemas.some((t) => t.name === 'generate_sub_module')
  return [
    systemPrompt ? `${systemPrompt}\n` : '',
    `任务：${mission}`,
    '',
    '你有工具可用，不要凭记忆写作——需要用 read_code 现场读源码，用 edit_article 逐步把文章写出来。',
    '',
    '可用工具：',
    toolList,
    '',
    '工作方式（重要）：',
    '1. 先用 list_files 看清目录结构，再挑出与本模块相关的文件；',
    '2. 用 read_code 逐个读你打算引用的文件。返回的每行带「行号| 」前缀，引用位置时一律用这个行号；',
    '3. 用 edit_article 的 insert 从第 0 行开始搭出 frontmatter 与章节骨架；',
    '4. 用 str_replace 逐段把内容填实（old_str 必须唯一匹配，因此请带足上下文）；',
    '5. 全部写完后，用 edit_article view 通读一遍，修正行号与不准确之处；',
    '6. 确认无误后，输出一句话说明你已完成，不要再调用工具。',
    ...(hasSub ? [
      '',
      '拆分（可选，只在确实必要时）：',
      '- 如果你发现本模块里有一整块子能力值得单独成文（通常 ≥3 个组件、且有自己的职责边界），',
      '  可以调 generate_sub_module 把它派出去：插件会让另一个写作者单独为它写 modules/<本模块>/<子模块>.md。',
      '- 派出去之后，本模块文章里对应小节只写「它做什么、为什么这样切、去哪看」并链接子文章，',
      '  不要在这里重复子模块的细节。',
      '- 不要为了省字数而滥用：拆得太碎会让读者在文章间跳来跳去。小模块（<3 个组件）一律自己写完。',
    ] : []),
    '',
    '硬要求：',
    '- 不许编造文件、函数、行号。没读过的文件不许引用。',
    '- 文章要用到真实行号：以 read_code 返回的前缀为准，禁止自行数行。',
    '- 不要用 markdown 围栏把整篇文章包起来。',
    ...(articleFormat ? ['', articleFormat] : []),
  ].filter(Boolean).join('\n')
}
