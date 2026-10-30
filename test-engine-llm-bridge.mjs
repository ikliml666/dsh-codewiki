// loopback 桥的服务器级测试（阶段 1B）。
//
// 与 test-engine-bridge.mjs 的分工：那边测纯转换（请求/响应映射），这里测**边界行为**——
// 也就是「桥作为宿主凭证的看门人」是否真的守住了。这些行为错了不会报错，只会悄悄
// 把凭证能力开放出去，所以必须有断言：
//
//   · 非 loopback 绑定 + 随机端口（这里断言绑的是 127.0.0.1）；
//   · 没有正确占位 key 一律 401，且错误体不回显收到的 key；
//   · 日志里永不出现 Authorization / 真实 key；
//   · 上游失败 → 502 + OpenAI 风格错误体（引擎能按 status 记账）；
//   · 流式：边收边发 + 以 [DONE] 收尾；上游中途失败 → 错误帧后仍以 [DONE] 收尾
//     （否则引擎的 SSE 读取会挂住）；
//   · 客户端断连 → 上游 signal 被 abort（省 token，取消语义生效）；
//   · 超时 → abort。
//
// 用一个假的 llm.stream 模拟宿主，不需要真实 provider，也不涉及任何密钥。
import assert from 'node:assert/strict'
import { startLlmBridge } from './lib/engine/llm-bridge.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

// 假宿主 llm：按脚本产出 chunk，并记录收到的请求（供断言「桥有没有正确转发」）。
function fakeLlm(script) {
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      const produced = script(options)
      for await (const c of produced) yield c
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withBridge(opts, fn) {
  const bridge = await startLlmBridge(opts)
  try { return await fn(bridge) } finally { await bridge.close() }
}

async function post(bridge, body, { key = bridge.placeholderKey, signal } = {}) {
  const res = await fetch(`${bridge.url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal,
  })
  return res
}

const simpleBody = { messages: [{ role: 'user', content: '写一段话' }] }

await check('桥绑定 127.0.0.1 随机端口，url 指向 /v1', async () => {
  const llm = fakeLlm(async function* () { yield { type: 'text-delta', index: 0, text: 'x' } })
  await withBridge({ llm, provider: 'workbuddy', model: 'hy3' }, async (bridge) => {
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    assert.ok(bridge.port > 0)
    assert.match(bridge.placeholderKey, /^dsh-bridge-[a-z0-9-]+$/)
  })
})

await check('缺少 Authorization → 401，且错误体不回显任何 key', async () => {
  const llm = fakeLlm(async function* () { yield { type: 'text-delta', index: 0, text: 'x' } })
  await withBridge({ llm, provider: 'p', model: 'm' }, async (bridge) => {
    const res = await post(bridge, simpleBody, { key: null })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.match(body.error.message, /bridge key/)
    assert.equal(llm.calls.length, 0, '被拒的请求绝不能触达宿主 llm')
    assert.equal(bridge.stats().authRejected, 1)
  })
})

await check('用真实形态的 key（非占位）→ 401，且该 key 不出现在响应里', async () => {
  const llm = fakeLlm(async function* () { yield { type: 'text-delta', index: 0, text: 'x' } })
  await withBridge({ llm, provider: 'p', model: 'm' }, async (bridge) => {
    const res = await post(bridge, simpleBody, { key: 'sk-live-should-not-work' })
    assert.equal(res.status, 401)
    const text = await res.text()
    assert.ok(!text.includes('sk-live-should-not-work'), '错误响应里回显了用户 key')
    assert.equal(llm.calls.length, 0)
  })
})

await check('非流式：返回 OpenAI 形状，且 usage 从 DSH 互斥计数正确折算', async () => {
  const llm = fakeLlm(async function* () {
    yield { type: 'text-delta', index: 0, text: '你好' }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await withBridge({ llm, provider: 'workbuddy', model: 'hy3' }, async (bridge) => {
    const res = await post(bridge, simpleBody)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].message.content, '你好')
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.equal(body.usage.prompt_tokens, 16, '净输入 10 + 缓存读 6')
    assert.equal(body.usage.completion_tokens, 4)
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 6)
    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].provider, 'workbuddy')
    assert.equal(llm.calls[0].model, 'hy3')
    assert.equal(llm.calls[0].system, undefined)
  })
})

await check('非流式：工具调用被拼成完整 arguments，并带 tool_calls', async () => {
  const llm = fakeLlm(async function* () {
    yield { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'read_file', argumentsDelta: '{"pa' }
    yield { type: 'tool-call-delta', index: 0, id: 'call_a', argumentsDelta: 'th":"x.py"}' }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })
  await withBridge({ llm, provider: 'p', model: 'm' }, async (bridge) => {
    const res = await post(bridge, { ...simpleBody, tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] })
    const body = await res.json()
    const call = body.choices[0].message.tool_calls[0]
    assert.equal(call.function.name, 'read_file')
    assert.equal(call.function.arguments, '{"path":"x.py"}')
    assert.equal(body.choices[0].finish_reason, 'tool_calls')
    assert.equal(llm.calls[0].tools.length, 1, 'tools 必须被转发给宿主 llm，否则模型无法调工具')
  })
})

await check('流式：SSE 逐帧下发并以 [DONE] 收尾', async () => {
  const llm = fakeLlm(async function* () {
    yield { type: 'text-delta', index: 0, text: 'A' }
    yield { type: 'text-delta', index: 0, text: 'B' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await withBridge({ llm, provider: 'p', model: 'm' }, async (bridge) => {
    const res = await post(bridge, { ...simpleBody, stream: true })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const text = await res.text()
    assert.ok(text.endsWith('data: [DONE]\n\n'), '缺少终止帧会让引擎的流读取挂住')
    const payloads = text.split('\n\n').filter(Boolean).map((f) => f.replace(/^data: /, ''))
    const objs = payloads.filter((p) => p !== '[DONE]').map((p) => JSON.parse(p))
    const content = objs.map((o) => o.choices?.[0]?.delta?.content ?? '').join('')
    assert.equal(content, 'AB')
    assert.equal(bridge.stats().streamRequests, 1)
  })
})

await check('流式：上游中途失败 → 错误帧 + [DONE] 收尾（不挂住客户端）', async () => {
  const llm = fakeLlm(async function* () {
    yield { type: 'text-delta', index: 0, text: '半截' }
    throw new Error('上游 429 限流')
  })
  await withBridge({ llm, provider: 'p', model: 'm' }, async (bridge) => {
    const res = await post(bridge, { ...simpleBody, stream: true })
    const text = await res.text()
    assert.ok(text.endsWith('data: [DONE]\n\n'))
    assert.match(text, /429/)
    assert.equal(bridge.stats().failures, 1)
  })
})

await check('非流式：上游失败 → 502 + OpenAI 错误体', async () => {
  const llm = fakeLlm(async function* () { throw new Error('上游鉴权失败') })
  await withBridge({ llm, provider: 'p', model: 'm' }, async (bridge) => {
    const res = await post(bridge, simpleBody)
    assert.equal(res.status, 502)
    const body = await res.json()
    assert.match(body.error.message, /鉴权失败/)
    assert.equal(bridge.stats().lastError, '上游鉴权失败')
  })
})

await check('非法 JSON → 400，不触达宿主 llm', async () => {
  const llm = fakeLlm(async function* () { yield { type: 'text-delta', index: 0, text: 'x' } })
  await withBridge({ llm, provider: 'p', model: 'm' }, async (bridge) => {
    const res = await fetch(`${bridge.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.placeholderKey}` },
      body: '{不是 json',
    })
    assert.equal(res.status, 400)
    assert.equal(llm.calls.length, 0)
  })
})

await check('空 messages → 400（桥不转发空请求）', async () => {
  const llm = fakeLlm(async function* () { yield { type: 'text-delta', index: 0, text: 'x' } })
  await withBridge({ llm, provider: 'p', model: 'm' }, async (bridge) => {
    const res = await post(bridge, { messages: [] })
    assert.equal(res.status, 400)
    assert.equal(llm.calls.length, 0)
  })
})

await check('/v1/models 需要占位 key，返回配置的模型', async () => {
  const llm = fakeLlm(async function* () {})
  await withBridge({ llm, provider: 'workbuddy', model: 'hy3' }, async (bridge) => {
    const noKey = await fetch(`${bridge.url}/models`)
    assert.equal(noKey.status, 401)
    const ok = await fetch(`${bridge.url}/models`, { headers: { authorization: `Bearer ${bridge.placeholderKey}` } })
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.equal(body.data[0].id, 'hy3')
    assert.equal(body.data[0].owned_by, 'workbuddy')
  })
})

await check('同格式但非本次生成的占位 key → 401，不触发模型', async () => {
  const llm = fakeLlm(async function* () { yield { type: 'text-delta', index: 0, text: '不该执行' } })
  await withBridge({ llm, provider: 'p', model: 'm' }, async (bridge) => {
    const forged = `dsh-bridge-${'a'.repeat(64)}`
    assert.notEqual(forged, bridge.placeholderKey)
    const res = await post(bridge, simpleBody, { key: forged })
    assert.equal(res.status, 401)
    assert.equal(llm.calls.length, 0)
  })
})

await check('/healthz 不需要 key，但不泄露任何凭证信息', async () => {
  const llm = fakeLlm(async function* () {})
  await withBridge({ llm, provider: 'workbuddy', model: 'hy3' }, async (bridge) => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/healthz`)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.ok(!/key|secret|token/i.test(text), text)
  })
})

await check('日志不含 Authorization，也不含占位 key 本身', async () => {
  const logs = []
  const llm = fakeLlm(async function* () {
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await withBridge({ llm, provider: 'p', model: 'm', onLog: (e) => logs.push(e) }, async (bridge) => {
    await (await post(bridge, simpleBody)).text()
    await (await post(bridge, simpleBody, { key: null })).text()
    assert.ok(logs.length >= 2)
    const flat = JSON.stringify(logs)
    assert.ok(!/authorization|bearer/i.test(flat), '日志里出现了 Authorization')
    assert.ok(!flat.includes(bridge.placeholderKey), '日志里出现了占位 key')
    assert.ok(logs.every((l) => typeof l.status === 'number' && typeof l.ms === 'number'))
  })
})

await check('客户端断连 → 上游 signal 被 abort（取消语义生效）', async () => {
  let aborted = null
  const llm = {
    async *stream(options) {
      options.signal?.addEventListener('abort', () => { aborted = options.signal.reason ?? 'aborted' })
      // 慢慢吐，留出断连窗口
      for (let i = 0; i < 40; i++) {
        if (options.signal?.aborted) return
        yield { type: 'text-delta', index: 0, text: '.' }
        await sleep(20)
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  await withBridge({ llm, provider: 'p', model: 'm' }, async (bridge) => {
    const ac = new AbortController()
    const p = post(bridge, { ...simpleBody, stream: true }, { signal: ac.signal }).catch(() => null)
    await sleep(120)
    ac.abort()
    await p
    await sleep(200)
    assert.ok(aborted !== null, '客户端断连后上游没有被 abort，会白烧 token')
  })
})

await check('超时 → 上游 signal 被 abort，非流式返回 502', async () => {
  const llm = {
    async *stream(options) {
      await new Promise((resolve) => {
        options.signal?.addEventListener('abort', resolve)
        setTimeout(resolve, 3000)
      })
      throw new Error('aborted by timeout')
    },
  }
  await withBridge({ llm, provider: 'p', model: 'm', timeoutMs: 150 }, async (bridge) => {
    const res = await post(bridge, simpleBody)
    assert.equal(res.status, 502)
  })
})

await check('启动参数缺失 → 抛错（不让桥以半配置状态监听端口）', async () => {
  assert.throws(() => startLlmBridge({}), /llm/)
  assert.throws(() => startLlmBridge({ llm: { stream() {} } }), /provider/)
  assert.throws(() => startLlmBridge({ llm: { stream() {} }, provider: 'p' }), /model/)
})

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack ?? f.err.message}`)
  process.exitCode = 1
}
