// 宿主模型 loopback 桥的转换契约测试（阶段 1B）。
//
// 背景：FSoft 原生引擎只认 OpenAI-compatible 的 base_url + api_key。DSH 的凭证在宿主
// provider 配置里，插件既不保存也不传递密钥（0.10.1 起的硬约束）。于是桥必须是这样：
//
//   引擎 --(loopback URL + 占位 key)--> Node 桥 --(宿主 llm.stream)--> 真实 provider
//
// 桥要做两件纯转换，而它们正是最容易悄悄错、且错了极难查的地方：
//
//   1. OpenAI 请求 → DSH GenerateOptions：messages 角色/工具 schema/参数映射；
//      尤其是 **tools 必须映射成 ToolSchema**，否则 agentic 工具循环会退化成
//      「模型说自己要调工具但永远调不到」，写出来的文章全是空壳。
//   2. DSH chunk 流 → OpenAI 响应（非流式 JSON / 流式 SSE）：tool_calls 的增量
//      拼接、finish_reason 映射、usage 字段名。流式与非流式**必须同源**，
//      否则引擎在流式路径上会拿到半截 tool_calls。
//
// 本文件只测纯转换（不启服务器、不连 provider），真实模型调用另有 1B 实测。
import assert from 'node:assert/strict'
import {
  toLlmRequest,
  finishReasonToOpenAI,
  chunksToCompletion,
  sseFrame,
  chunksToSse,
  PLACEHOLDER_KEY_PATTERN,
  isPlaceholderKey,
} from './lib/engine/openai-bridge.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

// ---------------------------------------------------------------------------
// 请求映射
// ---------------------------------------------------------------------------

await check('toLlmRequest：system 消息抽到 system 槽，其余按序进 messages', async () => {
  const out = toLlmRequest({
    provider: 'workbuddy',
    model: 'hy3',
    body: {
      model: 'hy3',
      messages: [
        { role: 'system', content: '你是文档工程师' },
        { role: 'user', content: '写一篇模块文档' },
      ],
    },
  })
  assert.equal(out.system, '你是文档工程师')
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].role, 'user')
  assert.equal(out.messages[0].content[0].type, 'text')
  assert.equal(out.messages[0].content[0].text, '写一篇模块文档')
  assert.equal(out.provider, 'workbuddy')
  assert.equal(out.model, 'hy3')
})

await check('toLlmRequest：没有 system 时 system 为 undefined（不塞空串污染请求）', async () => {
  const out = toLlmRequest({ provider: 'p', model: 'm', body: { messages: [{ role: 'user', content: 'hi' }] } })
  assert.equal(out.system, undefined)
})

await check('toLlmRequest：assistant 的 tool_calls 还原成 tool-call 块（含原始 JSON 字符串）', async () => {
  const out = toLlmRequest({
    provider: 'p', model: 'm',
    body: {
      messages: [
        { role: 'user', content: '读文件' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"src/a.py"}' },
          }],
        },
      ],
    },
  })
  const asst = out.messages.find((m) => m.role === 'assistant')
  assert.ok(asst, 'assistant 消息必须被保留，否则工具循环断链')
  const call = asst.content.find((b) => b.type === 'tool-call')
  assert.ok(call, JSON.stringify(asst.content))
  assert.equal(call.id, 'call_1')
  assert.equal(call.name, 'read_file')
  assert.equal(call.arguments, '{"path":"src/a.py"}')
})

await check('toLlmRequest：tool 角色消息映射成 tool 结果，callId 与 isError 都对得上', async () => {
  const out = toLlmRequest({
    provider: 'p', model: 'm',
    body: {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'tool', tool_call_id: 'call_1', content: '文件内容' },
      ],
    },
  })
  const tool = out.messages.find((m) => m.role === 'tool')
  assert.ok(tool, '工具结果必须进 messages')
  assert.equal(tool.toolCallId, 'call_1')
  assert.equal(tool.isError, false)
  assert.equal(tool.content[0].type, 'text')
  assert.equal(tool.content[0].text, '文件内容')
})

await check('toLlmRequest：tools 映射成 ToolSchema（name/description/parameters 原样）', async () => {
  const out = toLlmRequest({
    provider: 'p', model: 'm',
    body: {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: '读一个文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      }],
    },
  })
  assert.equal(out.tools.length, 1)
  assert.equal(out.tools[0].name, 'read_file')
  assert.equal(out.tools[0].description, '读一个文件')
  assert.deepEqual(out.tools[0].parameters, {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
  })
})

await check('toLlmRequest：temperature / max_tokens / stop 映射；未知字段不塞进请求', async () => {
  const out = toLlmRequest({
    provider: 'p', model: 'm',
    body: {
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.2,
      max_tokens: 512,
      stop: ['@@@end'],
      response_format: { type: 'json_object' },
      seed: 7,
    },
  })
  assert.equal(out.temperature, 0.2)
  assert.equal(out.maxTokens, 512)
  assert.deepEqual(out.stop, ['@@@end'])
  assert.equal(out.responseFormat, undefined, 'OpenAI 的 response_format 不该被塞进 DSH 请求')
  assert.equal(out.seed, undefined)
})

await check('toLlmRequest：多模态 content 数组（text 部分）被正确摊平', async () => {
  const out = toLlmRequest({
    provider: 'p', model: 'm',
    body: {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }],
      }],
    },
  })
  const texts = out.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text)
  assert.deepEqual(texts, ['第一段', '第二段'])
})

await check('toLlmRequest：空 messages 抛错（桥不能把空请求转发出去）', async () => {
  assert.throws(() => toLlmRequest({ provider: 'p', model: 'm', body: { messages: [] } }), /messages/)
  assert.throws(() => toLlmRequest({ provider: 'p', model: 'm', body: {} }), /messages/)
})

await check('toLlmRequest：缺 provider/model 抛错（路由不明会让请求落到错误端点）', async () => {
  assert.throws(() => toLlmRequest({ model: 'm', body: { messages: [{ role: 'user', content: 'x' }] } }), /provider/)
  assert.throws(() => toLlmRequest({ provider: 'p', body: { messages: [{ role: 'user', content: 'x' }] } }), /model/)
})

// ---------------------------------------------------------------------------
// 响应映射
// ---------------------------------------------------------------------------

await check('finishReasonToOpenAI：stop/tool-calls/max-tokens 一一对应，error/aborted 标 error', async () => {
  assert.equal(finishReasonToOpenAI({ kind: 'stop' }), 'stop')
  assert.equal(finishReasonToOpenAI({ kind: 'tool-calls' }), 'tool_calls')
  assert.equal(finishReasonToOpenAI({ kind: 'max-tokens' }), 'length')
  assert.equal(finishReasonToOpenAI({ kind: 'error', failure: { code: 'x', message: 'y' } }), 'error')
  assert.equal(finishReasonToOpenAI({ kind: 'aborted', failure: { code: 'x', message: 'y' } }), 'error')
  assert.equal(finishReasonToOpenAI(undefined), 'stop')
})

const chunk = (type, extra) => ({ type, ...extra })

await check('chunksToCompletion：文本 + 工具调用 + usage 组装成一个非流式响应', async () => {
  const res = chunksToCompletion({
    id: 'chatcmpl-1',
    model: 'hy3',
    chunks: [
      chunk('text-delta', { index: 0, text: '你好' }),
      chunk('text-delta', { index: 0, text: '，世界' }),
      chunk('tool-call-delta', { index: 1, id: 'call_9', name: 'read_file', argumentsDelta: '{"pa' }),
      chunk('tool-call-delta', { index: 1, id: 'call_9', argumentsDelta: 'th":"a.py"}' }),
      chunk('usage', { usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 } }),
      chunk('finish', { reason: { kind: 'tool-calls' } }),
    ],
  })
  assert.equal(res.object, 'chat.completion')
  assert.equal(res.id, 'chatcmpl-1')
  assert.equal(res.model, 'hy3')
  const msg = res.choices[0].message
  assert.equal(msg.role, 'assistant')
  assert.equal(msg.content, '你好，世界')
  assert.equal(msg.tool_calls.length, 1)
  assert.equal(msg.tool_calls[0].id, 'call_9')
  assert.equal(msg.tool_calls[0].type, 'function')
  assert.equal(msg.tool_calls[0].function.name, 'read_file')
  assert.equal(msg.tool_calls[0].function.arguments, '{"path":"a.py"}', '增量必须拼成完整 JSON')
  assert.equal(res.choices[0].finish_reason, 'tool_calls')
  // DSH 的 TokenUsage 是**互斥**计数：inputTokens=11 是不含缓存的净输入，缓存单列。
  // OpenAI 的 prompt_tokens 含缓存 → 11 + 3 + 0 = 14（缓存仍单列在 details 里，不重复计费语义）
  assert.deepEqual(res.usage, {
    prompt_tokens: 14,
    completion_tokens: 7,
    total_tokens: 21,
    prompt_tokens_details: { cached_tokens: 3 },
  })
})

await check('chunksToCompletion：只有工具调用时 content 为 null（OpenAI 语义，不能是空串）', async () => {
  const res = chunksToCompletion({
    id: 'c', model: 'm',
    chunks: [
      chunk('tool-call-delta', { index: 0, id: 'call_1', name: 'f', argumentsDelta: '{}' }),
      chunk('finish', { reason: { kind: 'tool-calls' } }),
    ],
  })
  assert.equal(res.choices[0].message.content, null)
})

await check('chunksToCompletion：空流返回 stop 且 content 空串，不抛（引擎会自己判定没内容）', async () => {
  const res = chunksToCompletion({ id: 'c', model: 'm', chunks: [] })
  assert.equal(res.choices[0].finish_reason, 'stop')
  assert.equal(res.choices[0].message.content, '')
  assert.equal(res.usage.prompt_tokens, 0)
})

await check('chunksToCompletion：无 name 的 tool-call-delta 不产出半截工具（id 缺失也不崩）', async () => {
  const res = chunksToCompletion({
    id: 'c', model: 'm',
    chunks: [
      chunk('tool-call-delta', { index: 0, id: 'call_1', name: 'f', argumentsDelta: '{"a":1}' }),
      chunk('tool-call-delta', { index: 1, id: 'call_2', argumentsDelta: '{"b":2}' }), // 没 name
      chunk('finish', { reason: { kind: 'tool-calls' } }),
    ],
  })
  assert.equal(res.choices[0].message.tool_calls.length, 1, '缺 name 的调用无法执行，不该出现在结果里')
  assert.equal(res.choices[0].message.tool_calls[0].function.name, 'f')
})

await check('chunksToCompletion：reasoning 块不混进 content（思考不该出现在文章正文）', async () => {
  const res = chunksToCompletion({
    id: 'c', model: 'm',
    chunks: [
      chunk('reasoning-delta', { index: 0, text: '我在想…' }),
      chunk('text-delta', { index: 1, text: '正文' }),
      chunk('finish', { reason: { kind: 'stop' } }),
    ],
  })
  assert.equal(res.choices[0].message.content, '正文')
})

// ---------------------------------------------------------------------------
// SSE 流式
// ---------------------------------------------------------------------------

await check('sseFrame：格式是 data: <json>\\n\\n，[DONE] 是独立帧', async () => {
  assert.equal(sseFrame({ a: 1 }), 'data: {"a":1}\n\n')
  assert.equal(sseFrame('[DONE]'), 'data: [DONE]\n\n')
})

await check('chunksToSse：首个帧带 role，文本增量逐帧，末帧带 finish_reason', async () => {
  const frames = chunksToSse({
    id: 'chatcmpl-2',
    model: 'hy3',
    created: 1700000000,
    chunks: [
      chunk('text-delta', { index: 0, text: 'A' }),
      chunk('text-delta', { index: 0, text: 'B' }),
      chunk('finish', { reason: { kind: 'stop' } }),
    ],
  })
  const objs = frames.filter((f) => f !== 'data: [DONE]\n\n').map((f) => JSON.parse(f.slice(6)))
  assert.equal(objs[0].object, 'chat.completion.chunk')
  assert.equal(objs[0].choices[0].delta.role, 'assistant')
  const text = objs.map((o) => o.choices[0]?.delta?.content ?? '').join('')
  assert.equal(text, 'AB')
  const last = objs[objs.length - 1]
  assert.equal(last.choices[0].finish_reason, 'stop')
  assert.equal(frames[frames.length - 1], 'data: [DONE]\n\n', '必须以 [DONE] 收尾，否则引擎的流读取会挂住')
})

await check('chunksToSse：tool call 增量逐帧带 id/name/arguments 片段', async () => {
  const frames = chunksToSse({
    id: 'c', model: 'm', created: 1,
    chunks: [
      chunk('tool-call-delta', { index: 0, id: 'call_1', name: 'read_file', argumentsDelta: '{"p' }),
      chunk('tool-call-delta', { index: 0, id: 'call_1', argumentsDelta: ':1}' }),
      chunk('finish', { reason: { kind: 'tool-calls' } }),
    ],
  })
  const objs = frames.filter((f) => f !== 'data: [DONE]\n\n').map((f) => JSON.parse(f.slice(6)))
  const calls = objs.flatMap((o) => o.choices[0]?.delta?.tool_calls ?? [])
  assert.ok(calls.length >= 2, JSON.stringify(objs))
  assert.equal(calls[0].id, 'call_1')
  assert.equal(calls[0].function.name, 'read_file')
  const args = calls.map((c) => c.function?.arguments ?? '').join('')
  assert.equal(args, '{"p:1}')
  const last = objs[objs.length - 1]
  assert.equal(last.choices[0].finish_reason, 'tool_calls')
})

await check('chunksToSse：usage 单独成帧（带 usage 字段，OpenAI stream_options 语义）', async () => {
  const frames = chunksToSse({
    id: 'c', model: 'm', created: 1,
    chunks: [
      chunk('text-delta', { index: 0, text: 'x' }),
      chunk('usage', { usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
      chunk('finish', { reason: { kind: 'stop' } }),
    ],
  })
  const objs = frames.filter((f) => f !== 'data: [DONE]\n\n').map((f) => JSON.parse(f.slice(6)))
  const usageFrame = objs.find((o) => o.usage)
  assert.ok(usageFrame, '流式必须能带 usage，否则引擎的用量账本永远是 0')
  assert.equal(usageFrame.usage.prompt_tokens, 5)
  assert.equal(usageFrame.usage.completion_tokens, 2)
})

// ---------------------------------------------------------------------------
// 占位 key（凭证边界）
// ---------------------------------------------------------------------------

await check('isPlaceholderKey：只认桥自己发的占位 key，真实 key 一律不认', async () => {
  assert.equal(isPlaceholderKey('dsh-bridge-placeholder'), true)
  assert.equal(isPlaceholderKey('sk-real-secret-1234'), false)
  assert.equal(isPlaceholderKey(''), false)
  assert.equal(isPlaceholderKey(undefined), false)
  assert.match(PLACEHOLDER_KEY_PATTERN.source, /dsh-bridge/)
})

await check('toLlmRequest：绝不在返回里携带任何 api key 字段', async () => {
  const out = toLlmRequest({
    provider: 'p', model: 'm',
    body: { messages: [{ role: 'user', content: 'x' }], api_key: 'sk-should-not-pass' },
  })
  const flat = JSON.stringify(out)
  assert.ok(!/sk-should-not-pass/.test(flat), '请求对象里出现了密钥')
  assert.equal(out.apiKey, undefined)
})

// ---------------------------------------------------------------------------
// 回归（1C 真实模型暴露）：assistant 历史消息必须带 source
//
// 真实工具循环第二轮起，宿主 LlmRuntime.forAdapter() 会读 `message.source.replayState`；
// 桥生成的 assistant 消息若没有 source，就抛
// "Cannot read properties of undefined (reading 'replayState')"，
// 宿主把整个调用判为 finish=error，引擎侧表现为 "Please return text or call a tool."
// 然后耗尽重试。纯单测抓不到，只有真跑一次工具往返才会炸。
// ---------------------------------------------------------------------------

await check('toLlmRequest：assistant 历史消息必须带 source（宿主 forAdapter 会读 source.replayState）', async () => {
  const out = toLlmRequest({
    provider: 'workbuddy', model: 'hy3',
    body: {
      messages: [
        { role: 'user', content: '读代码' },
        {
          role: 'assistant',
          content: '好的',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_code_components', arguments: '{"a":1}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '结果' },
      ],
    },
  })
  const asst = out.messages.find((m) => m.role === 'assistant')
  assert.ok(asst, 'assistant 必须保留')
  assert.ok(asst.source, 'assistant 消息缺 source：宿主 forAdapter 会读 source.replayState 并抛错')
  assert.equal(asst.source.kind, 'model', 'source.kind 必须是 model')
  assert.equal(typeof asst.source.provider, 'string')
  assert.equal(typeof asst.source.model, 'string')
})

await check('toLlmRequest：assistant source 的 provider/model 取自本次路由（不能凭空捏造）', async () => {
  const out = toLlmRequest({
    provider: 'workbuddy', model: 'deepseek-v4.1-flash',
    body: { messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] },
  })
  const asst = out.messages.find((m) => m.role === 'assistant')
  assert.equal(asst.source.provider, 'workbuddy')
  assert.equal(asst.source.model, 'deepseek-v4.1-flash')
  assert.equal(asst.source.replayState, undefined, '桥没有 replay 能力，不应伪造 replayState')
})

await check('toLlmRequest：tool 消息带 toolCallId（宿主按 callId 配对，缺了就断链）', async () => {
  const out = toLlmRequest({
    provider: 'p', model: 'm',
    body: {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 't', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_9', content: 'r' },
      ],
    },
  })
  const tool = out.messages.find((m) => m.role === 'tool')
  assert.equal(tool.toolCallId, 'call_9')
})

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack ?? f.err.message}`)
  process.exitCode = 1
}
