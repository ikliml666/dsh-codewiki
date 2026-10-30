// agentic-host 适配层测试：裸消息 <-> 宿主 Message、多工具结果展开、chunk 收流、FS 越界。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toRequestMessages, makeHostStream, makeFsWorkspace } from './lib/agentic-host.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const P = 'workbuddy'
const M = 'hy3'

await check('user 消息转正式 UserMessage', async () => {
  const out = toRequestMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], { provider: P, model: M })
  assert.equal(out.length, 1)
  assert.equal(out[0].role, 'user')
  assert.ok(out[0].id, '缺 id')
  assert.equal(out[0].content[0].text, 'hi')
})

await check('assistant 消息带 provider/model 与 tool-call', async () => {
  const out = toRequestMessages([{
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'c1', name: 'read_code', arguments: '{"path":"a.js"}' }],
  }], { provider: P, model: M })
  assert.equal(out[0].role, 'assistant')
  assert.equal(out[0].source.kind, 'model')
  assert.equal(out[0].source.provider, P)
  assert.equal(out[0].source.model, M)
  assert.equal(out[0].content[0].type, 'tool-call')
})

await check('一条 tool 消息的多个结果展开成多条 ToolResultMessage', async () => {
  const out = toRequestMessages([{
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'r1' }], isError: false },
      { type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'r2' }], isError: true },
    ],
  }], { provider: P, model: M })
  assert.equal(out.length, 2, '应展开成两条')
  assert.equal(out[0].role, 'tool')
  assert.equal(out[0].toolCallId, 'c1')
  assert.equal(out[0].source.callId, 'c1')
  assert.equal(out[0].isError, false)
  assert.equal(out[1].toolCallId, 'c2')
  assert.equal(out[1].isError, true)
})

await check('已有 id 的 assistant 消息透传不重造', async () => {
  const first = toRequestMessages([{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }], { provider: P, model: M })[0]
  const again = toRequestMessages([first], { provider: P, model: M })
  assert.equal(again[0], first)
})

await check('未知 role 被忽略', async () => {
  const out = toRequestMessages([{ role: 'weird', content: [] }, { role: 'user', content: [{ type: 'text', text: 'k' }] }], { provider: P, model: M })
  assert.equal(out.length, 1)
})

// 假 llm.stream：按脚本吐 chunk
function fakeLlm(chunkScripts) {
  let i = 0
  return {
    async *stream(req) {
      const script = chunkScripts[Math.min(i++, chunkScripts.length - 1)]
      if (req.__capture) req.__capture(req)
      for (const c of script) yield c
    },
    lastReq: null,
  }
}

await check('makeHostStream 把 chunk 收成 blocks 并透传 tools', async () => {
  let captured = null
  const llm = {
    async *stream(req) {
      captured = req
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'hel' }
      yield { type: 'text-delta', index: 0, text: 'lo' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
      yield { type: 'usage', usage: { outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const stream = makeHostStream({ llm, provider: P, model: M })
  const out = await stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }], tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }] })
  assert.ok(Array.isArray(out.blocks))
  assert.equal(out.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''), 'hello')
  assert.equal(captured.tools.length, 1)
  assert.equal(captured.tools[0].name, 't')
  assert.equal(captured.temperature, 0)
})

await check('makeHostStream 无 tools 时不带 tools 字段', async () => {
  let captured = null
  const llm = {
    async *stream(req) {
      captured = req
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const stream = makeHostStream({ llm, provider: P, model: M })
  await stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }], tools: [] })
  assert.equal(captured.tools, undefined)
})

await check('makeHostStream finish=error 抛错', async () => {
  const llm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'boom' } } }
    },
  }
  const stream = makeHostStream({ llm, provider: P, model: M })
  await assert.rejects(async () => stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }), /boom/)
})

await check('makeHostStream 缺 llm 抛错', async () => {
  assert.throws(() => makeHostStream({ provider: P, model: M }), /需要宿主 llm 服务/)
})

await check('makeHostStream reasoningEffort 透传', async () => {
  let captured = null
  const llm = { async *stream(req) { captured = req; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const stream = makeHostStream({ llm, provider: P, model: M, reasoningEffort: 'high' })
  await stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] })
  assert.equal(captured.reasoningEffort, 'high')
})

// FS workspace
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwhost-'))
fs.mkdirSync(path.join(tmp, 'src'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'src', 'a.js'), 'export const a = 1\n')
fs.writeFileSync(path.join(tmp, 'root.txt'), 'hi\n')

await check('makeFsWorkspace 读文件', async () => {
  const ws = makeFsWorkspace(fs, path, tmp)
  assert.match(await ws.readFile('src/a.js'), /export const a = 1/)
})

await check('makeFsWorkspace 列目录（带 dir 标记）', async () => {
  const ws = makeFsWorkspace(fs, path, tmp)
  const list = await ws.listDir('.')
  const names = list.map((e) => `${e.path}:${e.dir ? 'd' : 'f'}`).sort()
  assert.deepEqual(names, ['root.txt:f', 'src:d'])
})

await check('makeFsWorkspace 列子目录用完整相对路径', async () => {
  const ws = makeFsWorkspace(fs, path, tmp)
  const list = await ws.listDir('src')
  assert.equal(list[0].path, 'src/a.js')
})

await check('makeFsWorkspace 拒绝越界读', async () => {
  const ws = makeFsWorkspace(fs, path, tmp)
  await assert.rejects(async () => ws.readFile('../../etc/passwd'), /越界/)
})

await check('makeFsWorkspace 拒绝越界列', async () => {
  const ws = makeFsWorkspace(fs, path, tmp)
  await assert.rejects(async () => ws.listDir('../..'), /越界/)
})


await check('同一批裸消息多次转换，MessageId 保持稳定（身份跨边界）', async () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'yo' }, { type: 'tool-call', id: 'c1', name: 'read_code', arguments: '{}' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }] },
  ]
  const a = toRequestMessages(messages, { provider: 'p', model: 'm' })
  const b = toRequestMessages(messages, { provider: 'p', model: 'm' })
  assert(a.length === b.length)
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].id, b[i].id, `第 ${i} 条消息 id 应稳定`)
  }
  assert.equal(a[2].toolCallId, 'c1')
})
if (fails.length) for (const f of fails) console.log(`\n--- ${f.label} ---\n${f.err.stack}`)
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) for (const f of fails) console.log(`\n--- ${f.label} ---\n${f.err.stack}`)
process.exit(fails.length ? 1 : 0)
