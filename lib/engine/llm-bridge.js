// 宿主模型 loopback 桥（阶段 1B 薄桥）。
//
// 职责只有一件事：把 FSoft 引擎发来的 OpenAI-compatible 请求，翻译成宿主的
// `llm.stream(GenerateOptions)`，再把 chunk 流翻译回 OpenAI 响应。
//
// 凭证边界（这是整个迁移最不能破的一条）：
//   · 桥**不读**任何凭证文件、**不接收**真实 api_key、**不转发** Authorization 头；
//   · 引擎侧只拿到 `http://127.0.0.1:<随机端口>/v1` 和一个占位 key
//     （`dsh-bridge-...`），占位 key 的唯一作用是让引擎的 OpenAI 客户端肯发请求；
//   · 真实凭证只存在于宿主 provider 内部——桥通过传入的 `llm` 对象间接触发，
//     自己从头到尾看不见它；
//   · 访问日志与错误日志只记 method/path/状态/耗时/请求 id，**不记** Authorization。
//
// 为什么必须 loopback + 随机端口 + 占位 key 校验：
//   桥等于「用宿主凭证换任意模型调用」的开关。绑定 127.0.0.1 阻断外网；随机端口让
//   同机其它进程猜不到；占位 key 校验挡住误连/端口扫描。三者缺一都等于把宿主凭证
//   开放给本机任意进程。
//
// 协议面（只实现引擎真正用到的部分，不假装完整 OpenAI）：
//   POST /v1/chat/completions   非流式（stream 缺省/false）与流式（stream: true）
//   GET  /v1/models             引擎/探针的连通性检查
//   GET  /healthz               桥自身存活（不含任何模型信息）

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { PLACEHOLDER_KEY_PATTERN, chunksToCompletion, toLlmRequest, streamChunkToSse } from './openai-bridge.js'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_BODY_BYTES = 32 * 1024 * 1024

// 从 Authorization 头里取出 bearer token。只用于**校验占位 key**，取完即弃，
// 绝不写入日志、绝不放进请求对象、绝不传给 llm。
function bearerOf(req) {
  const raw = req.headers?.authorization
  if (typeof raw !== 'string') return ''
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m ? m[1].trim() : ''
}

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(text)
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// 把上游异常翻译成 OpenAI 风格的错误体（引擎按 status + error.message 记账）。
function errorBody(message, type = 'bridge_error', code = null) {
  return { error: { message: String(message ?? 'unknown'), type, code: code ?? null } }
}

// 会话记录里 prompt 的上限（字符）。原生通道单请求输入可达 110k–420k token，
// 全文落盘是几百 KB × 每个请求；面板只需要「跟模型说了什么」，取开头这段足够定位，
// 截断处显式标注，避免看的人以为原文就这么短。
const MAX_SESSION_PROMPT_CHARS = 200 * 1000

// 把 OpenAI messages 拼成一段可读文本，供会话记录展示（不是要还原成对话结构，
// 只求「能看到引擎到底把什么塞给了模型」）。role 前缀保留，方便分辨 system/user。
function messagesToPrompt(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  const parts = []
  for (const m of msgs) {
    const role = typeof m?.role === 'string' ? m.role : 'message'
    const c = m?.content
    let text = ''
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      text = c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
    }
    parts.push(`[${role}]\n${text}`)
  }
  const joined = parts.join('\n\n')
  return joined.length > MAX_SESSION_PROMPT_CHARS
    ? `${joined.slice(0, MAX_SESSION_PROMPT_CHARS)}\n\n…（prompt 超长，已截断，原长 ${joined.length} 字符）`
    : joined
}

// 会话记录里的任务名：原生通道没有「文章名」这种粒度，用请求里的模型标识代替，
// 面板的会话列表至少能分辨是哪个模型的哪一次调用。
function sessionNameOf(body, fallbackModel) {
  const m = typeof body?.model === 'string' && body.model ? body.model : fallbackModel
  return `原生请求 · ${m}`
}

// 会话回调用沙箱包一层：面板记账失败绝不影响正在跑的模型请求。
function callSession(handle, method, ...args) {
  try {
    handle?.[method]?.(...args)
  } catch {
    /* 记录失败不影响请求 */
  }
}

/**
 * 启动桥。返回 {url, placeholderKey, port, close(), stats()}。
 *
 * @param {object} opts
 * @param {{stream: Function}} opts.llm  宿主 llm 服务（只用 stream，不碰凭证）
 * @param {string} opts.provider         宿主 provider id（如 volces-ark）
 * @param {string} opts.model            模型 id（如 glm-5.3-flash）
 * @param {string} [opts.reasoningEffort]
 * @param {number} [opts.timeoutMs]      单次模型调用超时
 * @param {(entry:object)=>void} [opts.onLog]  结构化日志回调（**不含** Authorization）
 * @param {(task:object)=>object|null} [opts.onRequestStart]  会话记录钩子：每个 chat 请求开始时
 *        调用一次，返回 {onDelta,onDone,onError} 句柄（缺省不记录）。task 只含 name/model/provider/
 *        batchPrompt，**不含** Authorization 与占位 key。
 */
export function startLlmBridge({ llm, provider, model, reasoningEffort, timeoutMs = DEFAULT_TIMEOUT_MS, onLog, onRequestStart } = {}) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('startLlmBridge: 需要宿主 llm 服务（llm.stream）')
  if (!provider) throw new Error('startLlmBridge: 需要 provider')
  if (!model) throw new Error('startLlmBridge: 需要 model')

  // 占位 key 每次启动随机生成：不复用、不落盘、不进日志。
  const placeholderKey = `dsh-bridge-${randomBytes(32).toString('hex')}`
  // emptyResponses：上游 200 但一个产出型 chunk 都没有的调用次数。这是「引擎说这页
  // 无需改动、实际一篇文章没写」的唯一可量化源头——没有它，只能靠翻 chunk 日志数条数。
  const stats = { requests: 0, streamRequests: 0, authRejected: 0, failures: 0, emptyResponses: 0, lastError: null }
  const log = (entry) => { try { onLog?.(entry) } catch { /* 日志失败不影响请求 */ } }

  const server = createServer(async (req, res) => {
    const started = Date.now()
    const pathName = String(req.url ?? '').split('?')[0]
    // 每个请求收到的 chunk 类型计数。这是判断「模型真的返回空」与「桥丢包」的唯一手段：
    // 没有它，一次空产出既可能是上游没给内容，也可能是我们没把 tool-call 转出去。
    // 只记类型名与条数，正文一律不落日志（可能含源码与文章内容）。
    let chunkKinds = {}
    let chunkTotal = 0
    let usageSeen = null
    // 产出型 chunk：正文或工具调用。只有 reasoning / usage / finish 的调用等于「模型
    // 什么也没做」，引擎却会把它记成这一页无需改动。
    let produced = false
    const finish = (status) => log({
      at: new Date().toISOString(),
      method: req.method,
      path: pathName,
      status,
      ms: Date.now() - started,
      ...(chunkTotal ? { chunks: chunkKinds, chunkTotal } : {}),
      ...(usageSeen ? { usage: usageSeen } : {}),
    })
    // 只在「上游正常结束」的出口调用：中途失败已经由 failures 记账，不该再算空产出。
    const markProduced = () => { if (!produced) stats.emptyResponses++ }

    try {
      if (req.method === 'GET' && pathName === '/healthz') {
        finish(200)
        return sendJson(res, 200, { ok: true, provider, model })
      }

      // 所有 /v1 请求都必须带占位 key：这是桥唯一的准入闸门。
      if (pathName.startsWith('/v1')) {
        const token = bearerOf(req)
        if (!PLACEHOLDER_KEY_PATTERN.test(token) || token !== placeholderKey) {
          stats.authRejected++
          finish(401)
          // 错误体里不回显收到的 key（哪怕它是错的）——避免把用户误配的真实 key 写进日志
          return sendJson(res, 401, errorBody('invalid bridge key', 'invalid_request_error', 'invalid_api_key'))
        }
      }

      if (req.method === 'GET' && pathName === '/v1/models') {
        finish(200)
        return sendJson(res, 200, { object: 'list', data: [{ id: model, object: 'model', owned_by: provider }] })
      }

      if (req.method !== 'POST' || pathName !== '/v1/chat/completions') {
        finish(404)
        return sendJson(res, 404, errorBody(`unsupported route: ${pathName}`, 'invalid_request_error'))
      }

      stats.requests++
      const raw = await readBody(req)
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        stats.failures++
        finish(400)
        return sendJson(res, 400, errorBody('请求体不是合法 JSON', 'invalid_request_error'))
      }

      let options
      try {
        options = toLlmRequest({ provider, model, reasoningEffort, body })
      } catch (err) {
        stats.failures++
        stats.lastError = String(err?.message ?? err)
        finish(400)
        return sendJson(res, 400, errorBody(err?.message ?? err, 'invalid_request_error'))
      }

      const wantsStream = body?.stream === true
      if (wantsStream) stats.streamRequests++

      // 会话记录：面板「会话」视图靠它看「引擎把什么塞给了模型」。
      // 只记 messages 文本与模型输出，绝不把 Authorization / 占位 key 写进记录。
      let session = null
      try {
        session = onRequestStart?.({
          name: sessionNameOf(body, model),
          model,
          provider,
          batchPrompt: messagesToPrompt(body),
        }) ?? null
      } catch {
        session = null
      }

      // 客户端断连 → 中止上游调用（省 token，也让引擎的取消语义能真正生效）
      const ac = new AbortController()
      const onClose = () => ac.abort()
      res.on('close', onClose)
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      const cleanup = () => { clearTimeout(timer); res.off('close', onClose) }

      const chunks = []
      try {
        for await (const chunk of llm.stream({ ...options, signal: ac.signal })) {
          chunks.push(chunk)
          chunkTotal++
          const kind = String(chunk?.type ?? 'unknown')
          chunkKinds[kind] = (chunkKinds[kind] ?? 0) + 1
          if (chunk?.type === 'usage') usageSeen = { input: chunk.usage?.inputTokens ?? null, output: chunk.usage?.outputTokens ?? null }
          if (chunk?.type === 'text-delta' || chunk?.type === 'tool-call-delta') produced = true
          callSession(session, 'onDelta', chunk)
          // 流式边收边转：引擎在等第一个 token，攒完再发就失去流式意义
          if (wantsStream && !res.headersSent) {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            })
          }
          if (wantsStream && res.headersSent) {
            // 逐帧转换必须用 streamChunkToSse：chunksToSse 把入参当成「一整条已结束的流」，
            // 缺 finish 时会自己补一个结束帧。逐帧调用等于每个 reasoning / tool-call 分片后面
            // 都紧跟一个假的 finish_reason，引擎会以为这一轮已经结束（既不执行工具也没拿到正文），
            // 最终报 pydantic-ai 的 "Please return text or call a tool" 并重试到上限。
            for (const frame of streamChunkToSse(chunk, { id: `chatcmpl-${started}`, model, created: started })) {
              res.write(frame)
            }
          }
        }
      } catch (err) {
        cleanup()
        stats.failures++
        stats.lastError = String(err?.message ?? err)
        callSession(session, 'onError', err)
        if (wantsStream && res.headersSent) {
          // 流已开始：只能用终止帧表达失败（OpenAI 的做法是发一个 error 事件）
          res.write(`data: ${JSON.stringify(errorBody(err?.message ?? err, 'upstream_error'))}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          finish(200)
          return
        }
        finish(502)
        return sendJson(res, 502, errorBody(err?.message ?? err, 'upstream_error'))
      }
      cleanup()

      if (wantsStream) {
        if (!res.headersSent) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
        }
        res.write('data: [DONE]\n\n')
        res.end()
        // 收尾时用同一条 chunk 流折出正文与用量（foldChunks 是 openai-bridge 私有函数，
        // 这里走公开的 chunksToCompletion，语义一致且不额外导出内部实现）
        const folded = chunksToCompletion({ id: `chatcmpl-${started}`, model, chunks })
        callSession(session, 'onDone', folded.choices?.[0]?.message?.content ?? '', folded.usage?.completion_tokens ?? 0)
        markProduced()
        finish(200)
        return
      }

      const completion = chunksToCompletion({ id: `chatcmpl-${started}`, model, chunks })
      callSession(session, 'onDone', completion.choices?.[0]?.message?.content ?? '', completion.usage?.completion_tokens ?? 0)
      markProduced()
      finish(200)
      return sendJson(res, 200, completion)
    } catch (err) {
      stats.failures++
      stats.lastError = String(err?.message ?? err)
      finish(500)
      if (!res.headersSent) sendJson(res, 500, errorBody(err?.message ?? err, 'bridge_error'))
      else res.end()
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        placeholderKey,
        port,
        stats: () => ({ ...stats }),
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}
