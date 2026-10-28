// 探针（不属于产品代码）：用**假模型服务器**驱动真实 FSoft 入口，验证两件真事：
//   1. 五段进度真的被桥接成引擎八段协议行（graph 段不碰 LLM，能真跑出来）
//   2. 模型不可用时的异常被分类成 engine-model，而不是崩栈或误报 done
//
// 不接真模型是刻意的：本探针的目的是验证**协议与分类**，不是验证文章质量。
// 真模型那一环在 1B 已用 loopback 桥单独验证过（见 docs/fsoft-native-engine.md）。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PY = join(HERE, '..', '..', '..', '.probe-fsoft', 'venv', 'Scripts', 'python.exe')
const ENTRY = join(HERE, '..', '..', 'lib', 'engine', 'python', 'entry.py')
const REPO = join(HERE, '..', '..', '..', '.probe-fsoft', 'wiki_out_entry2')

// 假模型：永远回 429，逼出 engine-model 分类路径。
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'probe: 假模型服务器固定限流', type: 'rate_limit' } }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/v1`
console.log(`# 假模型服务器：${baseUrl}`)

const home = join(HERE, '..', '..', '..', '.probe-fsoft', 'probe-home')
mkdirSync(home, { recursive: true })

const child = spawn(PY, [ENTRY], {
  cwd: REPO,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEWIKI_NO_KEYRING: '1',
    PYTHONIOENCODING: 'utf-8',
    CODEWIKI_BASE_URL: baseUrl,
    CODEWIKI_API_KEY: 'probe-not-a-real-key',
    CODEWIKI_MAIN_MODEL: 'probe-model',
  },
})

child.stdin.write(JSON.stringify({
  requestId: 'probe-gen',
  action: 'generate',
  payload: { repoPath: REPO, docsDir: join(REPO, '.codewiki') },
}) + '\n')
child.stdin.end()

const lines = []
let buf = ''
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) break
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    try { lines.push(JSON.parse(line)) } catch { lines.push({ type: 'NOT-JSON', raw: line.slice(0, 200) }) }
  }
})
let errTail = ''
child.stderr.on('data', (c) => { errTail = (errTail + c.toString('utf8')).slice(-3000) })

const code = await new Promise((r) => child.on('exit', r))
server.close()

const progress = lines.filter((m) => m.type === 'progress')
const result = lines.find((m) => m.type === 'result')
console.log(`# 退出码：${code}`)
console.log(`# 协议行：hello=${lines.some((m) => m.type === 'hello')} progress=${progress.length} 非JSON行=${lines.filter((m) => m.type === 'NOT-JSON').length}`)
console.log('# 进度序列（前 12 条）：')
for (const p of progress.slice(0, 12)) {
  console.log(`  ${p.stage.padEnd(9)} ${String(p.percent).padStart(3)}%  ${p.message}`)
}
const stages = [...new Set(progress.map((p) => p.stage))]
console.log(`# 出现过的引擎阶段：${stages.join(' → ')}`)
console.log(`# 终态：${result?.result?.outcome} / code=${result?.result?.error?.code}`)
console.log(`# 错误信息前 160 字：${String(result?.result?.error?.message ?? '').slice(0, 160)}`)

const report = {
  exitCode: code,
  protocolLines: lines.length,
  nonJsonLines: lines.filter((m) => m.type === 'NOT-JSON').length,
  progressCount: progress.length,
  stages,
  outcome: result?.result?.outcome ?? null,
  errorCode: result?.result?.error?.code ?? null,
  stderrTail: errTail.slice(-1200),
}
writeFileSync(join(HERE, 'probe-generate.result.json'), JSON.stringify(report, null, 2))
console.log(`\n# 结果已写入 ${join(HERE, 'probe-generate.result.json')}`)
