// agentic 工具循环 <-> 宿主 llm 服务 的适配层。
//
// lib/agentic.js 是纯逻辑：它消费 {role, content} 裸消息、只认 blocks，方便离线测试。
// 宿主 llm.stream 要的是另一套形态：
//   - 消息必须是带 id + source 的正式 Message（createUserMessage / createAssistantMessage /
//     createToolResultMessage），不支持手搓裸对象；
//   - 一条 tool 消息只能装一个结果（ToolResultMessage 带 toolCallId + source.callId），
//     而工具循环里「一轮多个调用」是一条消息装多条结果 —— 这里负责展开成多条。
// 这层就做这两件事，外加把 chunk 流用 BlockAssembler 收成 blocks。

import {
  BlockAssembler, createUserMessage, createAssistantMessage, createToolResultMessage,
} from '@deepseek-ai/dsh-llm'

const SOURCE = { kind: 'plugin:codewiki' }

// 裸消息 -> 宿主 RequestMessage[]
export function toRequestMessages(messages, { provider, model } = {}) {
  const out = []
  for (const m of messages ?? []) {
    const role = m?.role
    const content = Array.isArray(m?.content) ? m.content : []
    if (role === 'user') {
      out.push(createUserMessage({ content, source: SOURCE }))
    } else if (role === 'assistant') {
      // 已经构造过的正式消息（有 id）直接透传，避免重复造身份
      if (m.id) { out.push(m); continue }
      out.push(createAssistantMessage({
        content: content.map((b) => (b?.type === 'tool-call' || b?.type === 'text' || b?.type === 'reasoning' ? b : b)),
        source: { provider: String(provider ?? ''), model: String(model ?? '') },
      }))
    } else if (role === 'tool') {
      // 循环里一条 tool 消息装多条结果 -> 宿主每条结果一条消息
      for (const r of content) {
        if (r?.type !== 'tool-result') continue
        out.push(createToolResultMessage({
          callId: r.toolCallId,
          content: Array.isArray(r.content) ? r.content : [{ type: 'text', text: String(r.content ?? '') }],
          isError: !!r.isError,
        }))
      }
    }
  }
  return out
}

// 建一个 streamFn 交给 runAgenticArticle。
// 返回 (params) => { blocks, finish, usage }
export function makeHostStream({ llm, provider, model, reasoningEffort = '', onDelta = null, onFinish = null }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('makeHostStream 需要宿主 llm 服务')
  return async ({ messages, tools = [], signal }) => {
    const assembler = new BlockAssembler()
    const reqMessages = toRequestMessages(messages, { provider, model })
    for await (const chunk of llm.stream({
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      messages: reqMessages,
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } })) } : {}),
      temperature: 0,
      signal,
    })) {
      assembler.push(chunk)
      if (onDelta) { try { onDelta(chunk) } catch { /* 记录失败不影响写作 */ } }
    }
    const finish = assembler.finish
    if (finish?.kind === 'error' || finish?.kind === 'aborted') {
      throw new Error(`agentic llm 失败（${finish.kind}，${String(finish.failure?.code ?? 'unknown')}）：${String(finish.failure?.message ?? '')}`)
    }
    const out = { blocks: assembler.blocks(), finish, usage: assembler.usage }
    if (onFinish) { try { onFinish(out) } catch { /* 忽略 */ } }
    return out
  }
}

// 仓库 workspace 抽象：agentic 的工具只认 readFile / listDir
export function makeFsWorkspace(fs, path, cwd) {
  const rootAbs = path.resolve(cwd)
  // 相对路径必须落在 cwd 内（符号链接逃逸由 safeRelPath 兜一层，这里再兜一层真实路径）
  const absOf = (rel) => {
    const abs = path.resolve(rootAbs, rel)
    const within = abs === rootAbs || abs.startsWith(rootAbs + path.sep)
    return within ? abs : null
  }
  return {
    async readFile(rel) {
      const abs = absOf(rel)
      if (!abs) throw new Error(`越界路径：${rel}`)
      return fs.readFileSync(abs, 'utf8')
    },
    async listDir(rel) {
      const abs = absOf(rel || '.')
      if (!abs) throw new Error(`越界路径：${rel}`)
      const entries = fs.readdirSync(abs, { withFileTypes: true })
      return entries.map((e) => ({
        path: rel && rel !== '.' ? `${rel.replace(/\/$/, '')}/${e.name}` : e.name,
        dir: e.isDirectory(),
      }))
    },
  }
}
