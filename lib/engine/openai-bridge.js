// OpenAI-compatible ↔ DSH LLM 的纯转换层（阶段 1B）。
//
// 为什么需要桥：FSoft 原生引擎只认 OpenAI-compatible 的 `base_url` + `api_key`。
// DSH 的凭证在宿主 provider 配置里，插件**既不保存也不传递密钥**（0.10.1 起硬约束）。
// 所以桥是一个跑在 127.0.0.1 上的进程内 HTTP 端点：引擎拿着占位 key 打过来，
// 桥把它转成 `llm.stream(GenerateOptions)`，用宿主自己的凭证去调真实 provider。
//
// 本文件只做**纯转换**（无 I/O、无网络、无密钥），让最容易出错的部分可被 TDD 钉死：
//
//   请求方向：OpenAI chat.completion 请求体 → GenerateOptions
//     · system 消息抽到 system 槽（DSH 的 one-shot 语义）
//     · assistant.tool_calls → tool-call 块（arguments 保持原始 JSON **字符串**，
//       DSH 的 ToolCallBlock 就是这么定义的，提前 parse 会破坏增量拼接）
//     · tool 消息 → ToolResultMessage（callId 必须对上，否则工具循环断链）
//     · tools[].function → ToolSchema（缺这一步 agentic 工具循环退化成空谈）
//
//   响应方向：DSH StreamChunk 流 → OpenAI 响应（非流式 JSON / 流式 SSE）
//     · tool-call-delta 必须按 index 拼接成完整 arguments，且**只产出带 name 的调用**
//       （无 name 的调用引擎无法执行，混进去会让引擎报一个莫名其妙的错误）
//     · reasoning-delta 不进 content（思考不该出现在文章正文里）
//     · usage 字段名映射：inputTokens 是**不含缓存**的净输入，OpenAI 的 prompt_tokens
//       含缓存，故 prompt_tokens = inputTokens + cacheRead + cacheWrite，缓存单列 details
//     · 流式与非流式共用同一套 chunk 折叠语义：chunksToCompletion 折整条流，
//       streamChunkToSse 逐帧转发。区别只在「这条流已经结束了没有」——逐帧转发绝不补
//       finish_reason，否则引擎会把每个中间分片当成一轮结束（既不执行工具也没拿到正文）。
//
// 安全边界：占位 key 是桥自己生成的固定串，桥**只**接受它；任何真实 key 都不该出现在
// 引擎侧配置里。toLlmRequest 的返回值里永远没有 apiKey 字段。

export const PLACEHOLDER_KEY_PATTERN = /^dsh-bridge-[a-z0-9-]+$/

const textBlock = (text) => ({ type: 'text', text: String(text ?? '') })

// OpenAI 的 content 可以是 string 或 parts 数组；统一摊平成 DSH 的 ContentBlock[]。
function contentToBlocks(content) {
  if (content == null) return []
  if (typeof content === 'string') return content ? [textBlock(content)] : []
  if (Array.isArray(content)) {
    const out = []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'text' && typeof part.text === 'string') out.push(textBlock(part.text))
      // image_url 等非文本部分目前不参与引擎写作（引擎只发文本），显式跳过而不是造块
    }
    return out
  }
  return []
}

function toolsToSchemas(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const t of tools) {
    const fn = t?.function ?? t
    if (!fn || typeof fn.name !== 'string' || !fn.name) continue
    out.push({
      name: fn.name,
      description: String(fn.description ?? ''),
      parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
    })
  }
  return out.length ? out : undefined
}

// 一条 OpenAI 消息 → 一条或多条 DSH RequestMessage。
// 注意 assistant 带 tool_calls 时 content 可能为 null，但消息本身必须保留（否则调用链断）。
//
// `route` = {provider, model}：assistant 历史消息**必须**带 `source.kind='model'`。
// 宿主 LlmRuntime.forAdapter() 会无条件读 `message.source.replayState` 来决定是否
// 丢弃跨适配器的 replay 数据；缺 source 就抛
// "Cannot read properties of undefined (reading 'replayState')"，整轮调用被判 error。
// 桥没有 replay 能力，所以只填 provider/model，**不伪造** replayState。
function messageToDsh(msg, route) {
  if (!msg || typeof msg !== 'object') return []
  const role = msg.role
  if (role === 'system' || role === 'developer') {
    // 统一交给调用方抽到 system 槽；这里保留为 text 便于合并
    const text = contentToBlocks(msg.content).map((b) => b.text).join('\n')
    return text ? [{ role: 'system', content: [textBlock(text)] }] : []
  }
  if (role === 'user') {
    const content = contentToBlocks(msg.content)
    return content.length ? [{ role: 'user', content }] : []
  }
  if (role === 'assistant') {
    const content = contentToBlocks(msg.content)
    for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
      const fn = call?.function ?? {}
      if (!call?.id || !fn.name) continue
      content.push({
        type: 'tool-call',
        id: String(call.id),
        name: String(fn.name),
        // 保持原始字符串：DSH 的 ToolCallBlock.arguments 就是 raw JSON string
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      })
    }
    if (!content.length) return []
    // source 不是可选的：见 messageToDsh 上方注释（宿主 forAdapter 会读它）。
    const source = route?.provider && route?.model
      ? { kind: 'model', provider: String(route.provider), model: String(route.model) }
      : null
    return [{
      role: 'assistant',
      content,
      ...(source ? { source } : {}),
    }]
  }
  if (role === 'tool') {
    if (!msg.tool_call_id) return []
    return [{
      role: 'tool',
      toolCallId: String(msg.tool_call_id),
      isError: msg.is_error === true,
      content: contentToBlocks(msg.content),
    }]
  }
  return []
}

// OpenAI 请求体 → DSH GenerateOptions（纯转换；provider/model 由桥的路由决定）。
//
// 入参：{provider, model, reasoningEffort?, body}
// 出参：GenerateOptions 的子集（不含 signal/sessionId，那些由服务器层加）
export function toLlmRequest({ provider, model, reasoningEffort, body } = {}) {
  if (!provider || typeof provider !== 'string') throw new Error('toLlmRequest: 缺 provider（路由不明会让请求落到错误端点）')
  if (!model || typeof model !== 'string') throw new Error('toLlmRequest: 缺 model')
  const messages = body?.messages
  if (!Array.isArray(messages) || !messages.length) throw new Error('toLlmRequest: messages 必须是非空数组')

  const systemParts = []
  const out = []
  const route = { provider, model }
  for (const msg of messages) {
    for (const dshMsg of messageToDsh(msg, route)) {
      if (dshMsg.role === 'system') {
        systemParts.push(...dshMsg.content.map((b) => b.text))
      } else {
        out.push(dshMsg)
      }
    }
  }
  if (!out.length) throw new Error('toLlmRequest: 除 system 外没有任何消息')

  const result = {
    provider,
    model,
    messages: out,
    system: systemParts.length ? systemParts.join('\n') : undefined,
  }
  if (reasoningEffort) result.reasoningEffort = reasoningEffort
  const tools = toolsToSchemas(body?.tools)
  if (tools) result.tools = tools
  if (typeof body?.temperature === 'number') result.temperature = body.temperature
  if (typeof body?.max_tokens === 'number') result.maxTokens = body.max_tokens
  if (Array.isArray(body?.stop)) result.stop = body.stop.map(String)
  return result
}

// DSH FinishReason → OpenAI finish_reason。
export function finishReasonToOpenAI(reason) {
  switch (reason?.kind) {
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    case 'error':
    case 'aborted': return 'error'
    case 'stop': return 'stop'
    default: return 'stop'
  }
}

// TokenUsage 是**互斥**计数（inputTokens 不含缓存），OpenAI 的 prompt_tokens 含缓存。
function usageToOpenAI(usage) {
  const input = Number(usage?.inputTokens) || 0
  const output = Number(usage?.outputTokens) || 0
  const cacheRead = Number(usage?.cacheReadTokens) || 0
  const cacheWrite = Number(usage?.cacheWriteTokens) || 0
  const prompt = input + cacheRead + cacheWrite
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: cacheRead },
  }
}

// 把 chunk 流折叠成「文本 + 按 index 拼接的工具调用 + usage + finish」的中间态。
// 非流式与流式两条路径都从这里出发，保证行为同源。
function foldChunks(chunks) {
  let text = ''
  let finish = null
  let usage = null
  const calls = new Map() // index → {id, name, args}
  for (const c of chunks ?? []) {
    switch (c?.type) {
      case 'text-delta':
        text += String(c.text ?? '')
        break
      case 'tool-call-delta': {
        const idx = Number(c.index) || 0
        const cur = calls.get(idx) ?? { id: String(c.id ?? ''), name: '', args: '' }
        if (c.id) cur.id = String(c.id)
        if (c.name) cur.name = String(c.name)
        cur.args += String(c.argumentsDelta ?? '')
        calls.set(idx, cur)
        break
      }
      case 'usage':
        usage = c.usage ?? null
        break
      case 'finish':
        finish = c.reason ?? null
        break
      // reasoning-delta / block-start / block-end 不进正文
      default:
        break
    }
  }
  // 只保留能执行的调用（有 name）；无 name 的调用引擎无法调用，混进去只会制造噪音
  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((v) => v.name)
    .map((v) => ({
      id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name: v.name, arguments: v.args || '{}' },
    }))
  return { text, finish, usage, toolCalls }
}

// chunk 流 → OpenAI 非流式响应体。
export function chunksToCompletion({ id, model, chunks } = {}) {
  const { text, finish, usage, toolCalls } = foldChunks(chunks)
  const hasCalls = toolCalls.length > 0
  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || '',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        // OpenAI 语义：纯工具调用时 content 为 null，不是空串
        content: text || (hasCalls ? null : ''),
        ...(hasCalls ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finish ? finishReasonToOpenAI(finish) : (hasCalls ? 'tool_calls' : 'stop'),
    }],
    usage: usageToOpenAI(usage),
  }
}

// 一帧 SSE。
export function sseFrame(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return `data: ${body}\n\n`
}

// 单个 chunk → SSE 帧数组（逐帧中转用；不补 finish，也不补 [DONE]）。
//
// 与 chunksToSse 的分工必须分清：chunksToSse 的入参是**一整条已经结束的流**，所以缺 finish
// 时它会自己补一个结束帧；而逐帧中转时，任何一个中间 chunk 后面都还没有结束，替它补
// finish_reason 会让 OpenAI 客户端认为「这一轮到此为止」——工具调用还没发完就被截断。
export function streamChunkToSse(c, { id, model, created } = {}) {
  if (!c || typeof c !== 'object') return []
  const ts = Number.isFinite(created) ? created : Math.floor(Date.now() / 1000)
  const base = () => ({ id: id || `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: ts, model: model || '' })
  const withRole = (delta) => (delta.role ? delta : { role: 'assistant', ...delta })

  switch (c.type) {
    case 'text-delta':
      return [sseFrame({ ...base(), choices: [{ index: 0, delta: withRole({ content: String(c.text ?? '') }), finish_reason: null }] })]
    case 'tool-call-delta':
      return [sseFrame({
        ...base(),
        choices: [{
          index: 0,
          delta: withRole({
            tool_calls: [{
              index: Number(c.index) || 0,
              ...(c.id ? { id: String(c.id) } : {}),
              type: 'function',
              function: {
                ...(c.name ? { name: String(c.name) } : {}),
                arguments: String(c.argumentsDelta ?? ''),
              },
            }],
          }),
          finish_reason: null,
        }],
      })]
    case 'usage':
      // OpenAI 的流式 usage 帧：choices 为空数组、带 usage
      return [sseFrame({ ...base(), choices: [], usage: usageToOpenAI(c.usage) })]
    case 'finish':
      return [sseFrame({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: finishReasonToOpenAI(c.reason) }] })]
    default:
      // reasoning-delta / block-start / block-end 等不映射成任何帧：
      // 引擎侧只认正文与工具调用，思考内容不该出现在文章正文里，也不该伪造结束。
      return []
  }
}
