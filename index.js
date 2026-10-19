// dsh-codewiki — 把 mraza007/codewiki（Rust CLI `cw`）接入 DeepSeek Harness。
// 提供两个工具：
//   cw                — 薄封装 CodeWiki CLI（init/status/index/meta/path/projects/setup/uninstall）
//   codewiki_generate — 服务化编译：判态后把编译任务提交给宿主常驻服务（侧边栏 CodeWiki 面板可见），
//                       服务按 规划 → 写文章 → 横切 → 审校 → 索引 推进，全部环节走百炼普通入口
//                       （chat/completions，任务输入压在 ≤32k token 低价档），零子代理。
//   codewiki_progress — 只读查编译进度：提交后随时查 stage/百分比/篇数/失败原因，立即返回不等待。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_NAME = 'dsh-codewiki'
export const name = PLUGIN_NAME
const CW_SUBCOMMANDS = ['init', 'status', 'index', 'meta', 'path', 'projects', 'setup', 'uninstall']
// 编译请求（同步 chat/completions）并发上限
const CONCURRENCY_HARD_CAP = 8

// Windows/Git-Bash 兼容：MSYS 盘符路径（/e/...）Node 的 fs 不认，归一化为 E:/...。
// 仅 win32 转换——POSIX 上 /e/... 可能是真实绝对路径，原样保留；识别不了的写法也原样交给 existsSync 报错。
function normalizeCwd(input) {
  const p = String(input ?? '').trim()
  if (process.platform !== 'win32') return p
  const m = p.match(/^\/([A-Za-z])\/(.*)$/)
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('停用后两个工具立即报错'),
  binaryPath: z.string().default('').volatile().description('cw 可执行文件路径；留空优先用 PATH 里的 cw（与 codewiki 源码同步），找不到再用插件自带 bin/cw(.exe)'),
  batchModel: z.string().default('qwen3.7-flash').volatile().description('编译模型（全部模型环节共用）'),
  batchApiKey: z.string().default('').volatile().description('阿里云百炼 API Key（DashScope），可选覆盖；留空自动用模型设置「阿里百炼云」渠道的凭证'),
  batchThinkingBudget: z.number().default(0).volatile().description('思考预算：0=关闭思考（省输出 Token）；1~32768=开启思考并限制预算'),
  maxConcurrency: z.number().default(CONCURRENCY_HARD_CAP).volatile().description('编译请求并发上限（1–8），硬顶 8'),
  articleLanguage: z.string().default('中文').volatile().description('wiki 文章书写语言'),
  updateReminder: z.boolean().default(true).volatile().description('会话系统提示注入 CodeWiki 维护提醒（仅当会话仓库根存在 wiki 入口 CodeWiki.md 时出现，收尾时提醒更新 wiki）'),
  excludePaths: z.string().default('').volatile().description('排除清单：这些目录（含子目录）不编译 CodeWiki。换行/分号/逗号分隔绝对路径'),
  autoUpdate: z.boolean().default(false).volatile().description('自动更新：定时扫描已编译过的工作区，检测到变更自动提交增量编译（scope=auto）'),
  autoUpdateMin: z.number().default(30).volatile().description('自动更新扫描间隔（分钟），最小 5'),
  workspaceOnly: z.boolean().default(true).volatile().description('任务页只显示属于已添加 dsh 工作区（宿主工作区列表）的任务'),
})

function val(x) {
  return x && typeof x === 'object' && typeof x.get === 'function' ? x.get() : x
}

function liveConfig(config) {
  const c = config ?? {}
  const concurrency = Number(val(c.maxConcurrency))
  return {
    enabled: val(c.enabled) ?? true,
    binaryPath: String(val(c.binaryPath) ?? '').trim(),
    batchModel: String(val(c.batchModel) ?? '').trim() || 'qwen3.7-flash',
    batchApiKey: String(val(c.batchApiKey) ?? '').trim(),
    batchThinkingBudget: Math.min(Math.max(Number(val(c.batchThinkingBudget)) || 0, 0), 32768),
    maxConcurrency: Number.isFinite(concurrency) && concurrency >= 1
      ? Math.min(concurrency, CONCURRENCY_HARD_CAP)
      : CONCURRENCY_HARD_CAP,
    articleLanguage: String(val(c.articleLanguage) ?? '').trim() || '中文',
    excludePaths: String(val(c.excludePaths) ?? ''),
    autoUpdate: val(c.autoUpdate) === true,
    autoUpdateMin: Math.max(5, Number(val(c.autoUpdateMin)) || 30),
    workspaceOnly: val(c.workspaceOnly) !== false,
  }
}

// ---------------------------------------------------------------------------
// cw 进程
// ---------------------------------------------------------------------------

function resolveBinary(cfg) {
  if (cfg.binaryPath) return cfg.binaryPath
  // PATH 优先：用户安装的 cw 与其 codewiki 源码同步演进；捆绑副本只在 PATH 找不到时兜底，
  // 避免捆绑二进制落后于源码时出现「bash 原生正常、包装层 No wiki found」的分叉。
  if (process.platform === 'win32') {
    try {
      const probe = spawnSync('where', ['cw'], { encoding: 'utf8', windowsHide: true })
      const first = String(probe.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
      if (probe.status === 0 && first && fs.existsSync(first)) return first
    } catch { /* 探测失败落到捆绑副本 */ }
  } else {
    try {
      const probe = spawnSync('which', ['cw'], { encoding: 'utf8' })
      const first = String(probe.stdout ?? '').trim().split(/\r?\n/)[0]
      if (probe.status === 0 && first) return first
    } catch { /* 探测失败落到捆绑副本 */ }
  }
  const local = path.join(pluginDir, 'bin', process.platform === 'win32' ? 'cw.exe' : 'cw')
  if (fs.existsSync(local)) return local
  return 'cw'
}

function runCw(binary, cwd, args, timeoutMs = 120000, signal) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }, timeoutMs)
    const onAbort = () => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode: -1, stdout, stderr: String(err?.message ?? err), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

// cw（本地 fork，源码 vendor/codewiki，行为基线上游 main 64323823）的三态输出
//   + 逐行清单：
//   'No wiki found. Run `cw init` first.' / 'Wiki has not been compiled yet.'
//   'Wiki is up to date.' / 'Changed since last compile (<hash>):' + '  M <file>'
//   'Stale articles:' + '  ! <article>'
// cw 0.5.0.2 起 Rust 层已用 rel_path_string 输出 `/` 分隔路径；本层规范化
// 保留为纵深防御（旧二进制或上游原版在 Windows 仍输出 `\`）。
// 历史：0.5.0.1 时真源码丢失（Temp/cw-src 被清理、vendor 是过期快照），
// 曾只能在插件层收口；0.5.0.2 重建 fork 后根治下沉到 Rust，见
// vendor/codewiki/FORK.md 与 .codewiki/learnings/cw-binary-source-lost.md。
export function normalizeArticlePath(p) { return String(p ?? '').replace(/\\/g, '/') }

// cw index 直接写盘 _index.md：把 [[link|title]] 链接内的 `\` 规范化为 `/`。
// 只动链接头（`[[` 到 `|` 之间），不碰标题与正文；文件不存在时静默跳过。
export function normalizeIndexLinks(cwd) {
  const p = path.join(cwd, '.codewiki', '_index.md')
  let text
  try { text = fs.readFileSync(p, 'utf8') } catch { return false }
  const fixed = text.replace(/\[\[([^\]|\n]*?)\|/g, (m, link) => `[[${link.replace(/\\/g, '/')}|`)
  if (fixed === text) return false
  fs.writeFileSync(p, fixed)
  return true
}

export function parseStatus(stdout) {
  const s = stdout ?? ''
  if (s.includes('No wiki found')) return { state: 'missing', changedFiles: [], staleArticles: [] }
  if (s.includes('has not been compiled yet')) return { state: 'uncompiled', changedFiles: [], staleArticles: [] }
  if (s.includes('Wiki is up to date')) return { state: 'clean', changedFiles: [], staleArticles: [] }
  const changedFiles = []
  const staleArticles = []
  for (const m of s.matchAll(/^\s+[M!]\s+(.+)$/gm)) {
    const line = m[1].trim()
    if (m[0].trimStart().startsWith('M')) changedFiles.push(normalizeArticlePath(line))
    else staleArticles.push(normalizeArticlePath(line))
  }
  return { state: 'stale', changedFiles, staleArticles }
}

// wiki 篇数：递归统计 <repo>/.codewiki/ 下的 .md 文章（含 _index），总览卡展示用
function countWikiArticles(wikiPath) {
  try {
    let n = 0
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name))
        else if (e.name.endsWith('.md')) n++
      }
    }
    walk(wikiPath)
    return n
  } catch { return null }
}

// CodeWiki.md 入口：编译收尾时若仓库根缺失则自动生成。139052c 把收尾提醒门控收紧到入口文件，
// 但流水线此前从未创建它——「编译过但无入口」的仓库永远收不到收尾提醒（不变量缺口）。
// 已有入口（人工/模型速查手册）绝不覆盖；生成失败只影响入口存在性，不应让编译任务失败。
export function ensureWikiEntry(cwd, language = '中文') {
  if (!cwd) return false
  const entryPath = path.join(cwd, 'CodeWiki.md')
  if (fs.existsSync(entryPath)) return false
  const wiki = path.join(cwd, '.codewiki')
  if (/中文|zh/i.test(String(language))) {
    fs.writeFileSync(entryPath, [
      '# CodeWiki',
      '',
      '本仓库的活 wiki 由 dsh-codewiki 编译流水线自动维护（`codewiki_generate` 工具 / 编译面板）。',
      '',
      `- 入口与全部文章位于仓库根 \`${wiki}\`（在仓库根之外读写它们时一律用绝对路径）`,
      '- 索引 .codewiki/_index.md · 架构总览 .codewiki/_architecture.md · 模块文章 .codewiki/modules/ · 概念 .codewiki/concepts/',
      '- 涉及代码改动的任务收尾必须运行 codewiki_generate（scope=auto）更新受影响文章；.codewiki/ 改动与代码一起提交',
      '',
      '> 本文件由编译流水线在缺失时自动生成；若改写为人工速查手册，流水线不会覆盖。',
      '',
    ].join('\n'), 'utf8')
  } else {
    fs.writeFileSync(entryPath, [
      '# CodeWiki',
      '',
      'The living wiki of this repo is maintained by the dsh-codewiki pipeline (`codewiki_generate` tool / the CodeWiki panel).',
      '',
      `- Entry and all articles live at \`${wiki}\` (use absolute paths outside the repo root)`,
      '- Index: .codewiki/_index.md · Architecture: .codewiki/_architecture.md · Modules: .codewiki/modules/ · Concepts: .codewiki/concepts/',
      '- After code changes, run codewiki_generate (scope=auto) at wrap-up; commit .codewiki/ together with the code',
      '',
      '> Auto-generated by the pipeline when missing; a hand-written entry is never overwritten.',
      '',
    ].join('\n'), 'utf8')
  }
  return true
}

// 排除清单：换行/分号/逗号分隔的绝对路径；cwd 等于某项或位于其子树内即被排除（Windows 大小写不敏感）。
// excludedItem 返回命中的排除项原文（工具报错据此告诉模型是哪条排除项拒绝了此工作区）；
// isExcluded 保持布尔语义（面板 repos 总览 excluded 字段依赖布尔）。
function excludedItem(cwd, list) {
  const items = String(list ?? '').split(/[\n;，,]+/).map((s) => s.trim()).filter(Boolean)
  if (!items.length || !cwd) return null
  const n = path.normalize(cwd).toLowerCase().replace(/[\\/]+$/, '')
  const hit = items.find((item) => {
    const m = path.normalize(item).toLowerCase().replace(/[\\/]+$/, '')
    return n === m || n.startsWith(m + '\\') || n.startsWith(m + '/')
  })
  return hit ?? null
}
function isExcluded(cwd, list) {
  return excludedItem(cwd, list) !== null
}

// ---------------------------------------------------------------------------
// Token 预算与输入装填
// ---------------------------------------------------------------------------

// 粗算 token 数：CJK 字符 ≈ 1 token/字，其余（ASCII 代码为主）≈ 3.5 字符/token。
// 只为把单请求输入压进 qwen3.7-flash ≤32k 输入低价档（约 $0.03/M；
// 32k-256k 档 $0.10/M 贵 3 倍多），不需要精确分词器。
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) cjk++
  }
  return cjk + Math.ceil((s.length - cjk) / 3.5)
}

// 同步单轮调用：全部走百炼普通入口（dashscope chat/completions）。零子代理。
async function bailianChat({ apiKey, model, thinkingBudget, prompt, signal }) {
  const body = { model, messages: [{ role: 'user', content: prompt }] }
  body.enable_thinking = thinkingBudget > 0
  if (thinkingBudget > 0) body.thinking_budget = thinkingBudget
  const text = await fetch(`${BAILIAN_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }).then(async (res) => {
    const text = await res.text()
    if (!res.ok) throw new Error(`百炼 chat/completions 失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
    return text
  })
  const j = JSON.parse(text)
  const content = j?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('实时调用响应缺少 content')
  return { content, outputTokens: Number(j?.usage?.output_tokens) || 0 }
}

// 任务结果统一出口：keepInMemory 任务（规划/校对）把 content 带回内存由服务侧消费，
// 文章任务直接落盘。普通任务与超大任务兜底共用。
function applyTaskResult(task, content, notes) {
  if (task.keepInMemory) return { name: task.name, ok: true, stopReason: 'completed', content }
  try {
    fs.mkdirSync(path.dirname(task.articlePath), { recursive: true })
    const fx = fixAnchors(content, task.cwd ?? null)
    if (fx.fixed > 0) notes.push(`文章 ${task.name} 自动修正 ${fx.fixed} 处行号锚点`)
    if (fx.unresolved.length) notes.push(`文章 ${task.name} 行号锚点存疑（未改）：${fx.unresolved.slice(0, 3).join('；')}${fx.unresolved.length > 3 ? ' 等' : ''}`)
    fs.writeFileSync(task.articlePath, fx.text, 'utf8')
    return { name: task.name, ok: true, stopReason: 'completed' }
  } catch (err) {
    notes.push(`文章 ${task.name} 落盘失败 —— ${String(err?.message ?? err)}`)
    return { name: task.name, ok: false, stopReason: 'error' }
  }
}

// 并发池：唯一执行器。按 maxConcurrency 同时在飞的同步请求逐个消费任务队列，
// 全部打百炼普通入口。signal 用于取消时中断在飞请求。
// onTaskDone 每任务上报 {outputTokens, durationMs} 供 tps 采样。
// 返回 Map(customId → 结果)（{ok, stopReason, content?}）。
export async function runRealtimeTasks(tasks, { apiKey, model, thinkingBudget, concurrency, notes, onTaskDone, signal }) {
  const results = new Map()
  let cursor = 0
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return
      const i = cursor++
      if (i >= tasks.length) return
      const t = tasks[i]
      try {
        const startedAt = Date.now()
        const { content, outputTokens } = await bailianChat({ apiKey, model, thinkingBudget, prompt: t.batchPrompt, signal })
        if (onTaskDone && outputTokens > 0) onTaskDone({ outputTokens, durationMs: Date.now() - startedAt })
        results.set(t.customId, applyTaskResult(t, content, notes))
      } catch (err) {
        notes.push(`${t.name} 请求失败 —— ${String(err?.message ?? err)}`)
        results.set(t.customId, { name: t.name, ok: false, stopReason: 'error' })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker))
  return results
}

// ---------------------------------------------------------------------------
// 模型执行（阿里云百炼 OpenAI 兼容接口，普通入口 dashscope.aliyuncs.com）
// 全部环节（规划/写文章/横切/校对）都是单轮文本生成，统一走这条通道：任务内联
// 输入 → 同步 chat/completions 后台并发池执行（进度/取消由服务记账）。
// 输入按 token 预算装填，压在 qwen3.7-flash ≤32k 输入低价档；
// 装不下的单文件升 200k 大档装填。请求随连接生死，宿主重启按 prompt 快照重跑。
// ---------------------------------------------------------------------------

const BAILIAN_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
// 单个请求的输入 token 预算：qwen3.7-flash 输入 ≤32k 档单价最低（约 $0.03/M），
// 留 ~4k 余量吸收估算误差与消息骨架开销。
const BATCH_TOKEN_BUDGET = 28000
// 32k–256k 输入档（3 倍价）的装填上限：超预算任务升到该档继续装填
//（百炼按请求实际输入自动分档计价），只有单文件连该档都装不下才转超大兜底/跳过校对。
const BATCH_TOKEN_HARD_LIMIT = 200000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// 源码行号前缀：每行加「N| 」grep 风格标注，让模型引用行号时以前缀为准而不是自己数行
// （弱模型自己数行首尾常对、中段系统性错位）。尾部至多去一个换行——多去会把真实空行
// 挤掉导致总行数偏小；split('\n') 后空文件得到 ['']，输出「1| 」可接受。
export function numberLines(content) {
  return content.replace(/\r?\n$/, '').split('\n').map((line, i) => `${i + 1}| ${line.replace(/\r$/, '')}`).join('\n')
}

// ---------------------------------------------------------------------------
// 行号锚点自动修正（第四层兜底）：文章落盘前把「file:NN(-MM)」锚点对照源码确定性校正。
// 语义与 test-wiki-anchors.mjs 的符号绑定一致：锚点起点行应包含该行反引号内符号（或其
// 末段）；不包含时在源文件全文找符号出现行——恰好一处 → 修正；多处 → 取唯一的行首声明
// 形态（function/class/const/let），仍歧义则不动；找不到 → 不动。全部修正只改行号数字，
// 绝不动文章其他内容；source_files 之外的文件引用一律不碰。符号提取规则复制自
// test-wiki-anchors.mjs symbolsOnLine（两处同源，改一处须同步另一处）。
export function fixAnchors(content, cwd) {
  const unresolved = []
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch || !cwd) return { text: content, fixed: 0, unresolved }
  const srcs = parseSourceFiles(fmMatch[1])
  if (!srcs.length) return { text: content, fixed: 0, unresolved }
  const resolveFile = (f) => {
    if (srcs.includes(f)) return f
    const cands = srcs.filter((r) => r.split('/').pop() === f)
    return cands.length === 1 ? cands[0] : null
  }
  const cache = new Map()
  const loadSource = (rel) => {
    if (!cache.has(rel)) {
      try {
        cache.set(rel, fs.readFileSync(path.join(cwd, rel), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/))
      } catch { cache.set(rel, null) }
    }
    return cache.get(rel)
  }
  const symbolsOnLine = (line) => {
    const out = []
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const sym = m[1].trim().replace(/\(.*\)$/, '').trim()
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(sym)) continue
      if (sym.length < 3 || sym.split('.').pop().length < 3) continue
      out.push(sym)
    }
    return out
  }
  const hasSym = (srcLine, s) => srcLine.includes(s) || srcLine.includes(s.split('.').pop())
  const bodyStart = fmMatch[0].split(/\r?\n/).length // 正文首行（1-based 行号 ≤ bodyStart 是 frontmatter）
  const crlf = /\r\n/.test(content)
  const lines = content.split(/\r?\n/)
  let fixed = 0
  const anchorRe = /([A-Za-z0-9_\-./]+):(\d+)(?:-(\d+))?/g
  const text = lines.map((line, idx) => {
    if (idx + 1 <= bodyStart) return line
    const syms = symbolsOnLine(line)
    if (!syms.length) return line
    return line.replace(anchorRe, (whole, f, n1, n2) => {
      const rel = resolveFile(f)
      if (!rel) return whole
      const src = loadSource(rel)
      if (!src) return whole
      const start = Number(n1)
      const at = `${rel}:${start}${n2 ? `-${n2}` : ''}`
      if (src[start - 1] && syms.some((s) => hasSym(src[start - 1], s))) return whole // 已正确
      let R = null
      let ambiguous = false
      for (const s of syms) {
        const hits = []
        src.forEach((l, i) => { if (hasSym(l, s)) hits.push(i + 1) })
        if (hits.length === 1) { R = hits[0]; break }
        if (hits.length > 1) {
          // 声明形态：符号是本行声明的目标（const gamma = beta() 这种「别的符号的声明」不算——
          // function/class 直接跟符号；const/let 要求符号后跟 =，排除赋值右侧引用）
          const tail = s.split('.').pop().replace(/[$]/g, '\\$')
          const defRe = new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?(?:function|class)\\s+${tail}\\b|^[ \\t]*(?:export\\s+)?(?:const|let)\\s+${tail}\\s*=`)
          const defs = hits.filter((n) => defRe.test(src[n - 1]))
          if (defs.length === 1) { R = defs[0]; break }
          ambiguous = true // 试下一个符号
        }
      }
      if (R === null) {
        unresolved.push(`${at} ${ambiguous ? '符号歧义' : '符号未找到'}未改`)
        return whole
      }
      if (n2) {
        const end2 = Number(n2)
        fixed += 1
        return `${f}:${R}-${Math.min(R + (end2 - start), src.length)}` // 区间尾越界钳到文件尾（修正起点是净改善）
      }
      fixed += 1
      return `${f}:${R}`
    })
  }).join(crlf ? '\r\n' : '\n') // 混合行尾按整文主风格规范化
  return { text, fixed, unresolved }
}

// 把源文件内联成 markdown 文本；按 token 预算整文件装填（不做半文件截断——半截代码误导行号）。
// 返回 { text, skipped, oversized }：skipped 是预算装不下的文件清单，oversized=true 表示
// 连第一个文件都装不下（text 原样带这一个文件，任务整体转超大兜底通道）。
export function collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET) {
  const parts = []
  const skipped = []
  let used = 0
  let first = true
  for (const rel of files) {
    const abs = path.join(cwd, rel)
    let content = null
    try { content = fs.readFileSync(abs, 'utf8') } catch { /* 缺文件在文内标注 */ }
    const body = content === null
      ? `### ${rel}\n\n（文件不存在或读取失败）\n`
      : `### ${rel}\n\n\`\`\`\n${numberLines(content)}\n\`\`\`\n`
    const size = estimateTokens(body)
    if (used + size > budget) {
      if (first) return { text: body, skipped: [], oversized: true }
      skipped.push(rel)
      continue
    }
    parts.push(body)
    used += size
    first = false
  }
  let text = parts.join('\n')
  if (skipped.length) {
    text += `\n（以下文件因单请求输入预算未内联，行号相关描述不得涉及它们：${skipped.join('、')}）\n`
  }
  return { text, skipped, oversized: false }
}

// 批量模式单轮文章 prompt：与智能体版共享格式条款（articleFormatSection），
// 区别是源码内联、文章由插件落盘，因此要求「只输出文章本身」。
function batchArticlePrompt({ language, mission, sourcesText, prevArticle }) {
  const parts = [
    `你是 CodeWiki 文章作者。文章全文用${language}书写。`,
    '',
    `任务：${mission}`,
    '',
    '以下是你需要的全部源码（路径相对仓库根；每行以「行号| 」前缀标注行号，引用行号一律以前缀为准）：',
    '',
    sourcesText,
  ]
  if (prevArticle) {
    parts.push(
      '',
      '这篇文章的当前内容（基于旧版代码，供保留章节结构与 title/type/tags；其中引用的行号可能已过期，一律不得沿用，行号必须按源码「行号| 」前缀重新标注）：',
      '',
      prevArticle,
    )
  }
  parts.push(
    '',
    '直接输出完整文章：以 --- frontmatter 开始（title/type/source_files/tags），',
    'source_files 列出上文中你实际引用的源文件（POSIX 风格相对路径，含上文的测试文件）。',
    '只输出文章本身——禁止用 markdown 代码围栏整体包裹、禁止任何解释文字。',
    '',
    articleFormatSection(),
  )
  return parts.join('\n')
}

/** apply 时捕获的宿主上下文，批量路径经它向宿主凭据库取模型渠道凭证 */
let hostCtxRef = null

/**
 * 百炼凭证解析链：显式 batchApiKey 优先；留空经宿主凭据库（credentials 服务）
 * 解析 ALIYUN_BAILIAN_API_KEY——即模型设置「阿里百炼云」渠道的 apiKeyEnv，
 * 与模型适配器同一份凭证（继承 env > 凭据库 > .env）。取不到返回 null。
 */
export async function resolveBatchApiKey(hostCtx, cfg) {
  const explicit = String(cfg?.batchApiKey ?? '').trim()
  if (explicit) return { key: explicit, source: 'config' }
  if (!hostCtx || typeof hostCtx.inject !== 'function') return null
  const svc = await Promise.race([
    (async () => {
      try {
        const sub = await hostCtx.inject(['credentials'])
        const got = Array.isArray(sub) ? sub[0] : sub?.credentials ?? sub
        return got && typeof got.resolve === 'function' ? got : null
      } catch { return null }
    })(),
    sleep(3000).then(() => null),
  ])
  if (!svc) return null
  try {
    const resolved = await svc.resolve('ALIYUN_BAILIAN_API_KEY')
    if (resolved?.value) return { key: resolved.value, source: `credentials(${resolved.source ?? 'unknown'})` }
  } catch { /* 凭据库解析失败按无凭证处理，走回退 */ }
  return null
}

// 把通用任务（sources+mission+可选 prevArticle）装配成批量请求：内联源码、拼 prompt、
// 分配 customId。
// 分割（观察→合成，复用横切先例）：模块源码总量超单请求预算时不再升 200k 大档吃 3 倍价，
// 而是按文件装填拆成多个 ≤28k 观察批（_split/ 任务，keepInMemory），收割后拼观察包
// 提交一个合成请求写完整文章。单文件连观察批预算都装不下（collectSources oversized）
// 才升大档重装；连大档都装不下才转超大兜底通道。full/stale 两条流都在本层生效。
// 返回 { prepared, oversized }：prepared 含普通任务与 _split/ 观察任务，
// 观察任务带 splitFor（所属文章 name）与 composePlan（重建合成任务所需，仅内存轮使用）。
export function prepareArticleTasks(tasks, { cwd, language }) {
  const prepared = []
  const oversized = []
  for (const t of tasks) {
    let { text, oversized: tooBig, skipped: overflowFiles } = collectSources(cwd, t.sources)
    if (tooBig) {
      ;({ text, oversized: tooBig } = collectSources(cwd, t.sources, BATCH_TOKEN_HARD_LIMIT))
    }
    const prevArticle = t.prevArticlePath
      ? (() => { try { return fs.readFileSync(t.prevArticlePath, 'utf8') } catch { return '' } })()
      : ''
    // 分割判定：prompt 估算超单请求预算，或 28k 装填有文件被跳过（collectSources 只装得下
    // 前缀，余下文件本会被「不得涉及」静默甩掉——截图场景）。两者都说明该模块一请求写不完。
    if (!tooBig && (overflowFiles.length > 0 || estimateTokens(batchArticlePrompt({ language, mission: t.mission, sourcesText: text, prevArticle })) > BATCH_TOKEN_BUDGET)) {
      // 总量超单请求预算：按 28k 逐文件装填分批，产出观察任务组
      const batches = []
      for (const rel of t.sources) {
        const one = collectSources(cwd, [rel])
        if (one.oversized) continue // 单文件连观察预算都超：不参与分批，走下方大档重装兜底
        const last = batches[batches.length - 1]
        if (last && estimateTokens(last.text + '\n' + one.text) <= BATCH_TOKEN_BUDGET) {
          last.text += '\n' + one.text
          last.files.push(rel)
        } else {
          batches.push({ text: one.text, files: [rel] })
        }
      }
      if (batches.length > 1) {
        const base = `split${prepared.length}`
        batches.forEach((b, i) => {
          prepared.push({
            customId: `${base}o${i}`,
            name: `${t.name}#obs${i}`,
            keepInMemory: true,
            batchPrompt: batchArticleObservePrompt(language, t.name, b.text, i, batches.length),
            splitFor: t.name,
            composePlan: {
              mission: t.mission, articlePath: t.articlePath,
              prevArticlePath: t.prevArticlePath ?? null,
              batchCount: batches.length, files: b.files,
            },
          })
        })
        continue
      }
      // 分不出多批（单文件占了全部体积）：落回大档装填，照旧提交（升档按 3 倍价），维持旧行为
      ;({ text, skipped: overflowFiles } = collectSources(cwd, t.sources, BATCH_TOKEN_HARD_LIMIT))
    }
    t.batchPrompt = batchArticlePrompt({ language, mission: t.mission, sourcesText: text, prevArticle })
    delete t.splitFor; delete t.composePlan // 复用任务对象时清残留分割字段
    if (tooBig) { oversized.push(t); continue }
    t.customId = t.customId ?? `t${prepared.length}`
    prepared.push(t)
  }
  return { prepared, oversized }
}

// ---------------------------------------------------------------------------
// prompt 模板（条款取自上游 skills/codewiki-session.md）
// ---------------------------------------------------------------------------

function articleFormatSection() {
  return [
    '文章格式（严格遵守）：',
    '```',
    '---',
    'title: <模块名>',
    'type: module',
    'source_files:',
    '  - path/to/file1',
    '  - path/to/test_file',
    'tags: [相关, 标签]',
    '---',
    '',
    '## Overview',
    '## Key Components',
    '## Architecture',
    '## Data Flow',
    '## Connections',
    '## Known Issues',
    '```',
    '- Key Components：列出该模块全部公开函数/类/常量及其行号与用途；每个 struct/model 的全部字段（含时间戳、自动生成字段）；全部方法（含属性方法、__str__、save() 等）',
    '- 行号以源码「行号| 」前缀为准（如 12| let conf_path = ... 即第 12 行），禁止自行数行或猜测；行号区间覆盖完整函数/代码块，不得截断',
    '- source_files 必须列出你为写本文读过的每一个文件（含测试文件），路径相对仓库根，POSIX 风格',
    '- 功能被禁用/注释时写明具体位置（哪个文件哪一行），不许只写 "disabled"',
    '- Architecture：组件 ≥3 或流程非平凡时，画 UTF-8 box-drawing 框图（┌ ┐ └ ┘ ─ │ ► ◄ ▼）放进 ```text 围栏，≤20 行，框内标注组件名与文件/类，箭头标注关系',
    '- Markdown 规范：## 顶级、### 子级不跳级；行内代码用反引号；多行代码用带语言标签的围栏；结构化对比用 markdown 表；标题/代码块/列表前后留空行',
    '- Connections 用 Obsidian [[backlinks]]（[[other-module]]）连接相关模块',
    '- 写给对这个代码库零上下文的未来 agent：具体到文件名、函数名、类型、行号；宁可多细节，不许概括省略',
  ].join('\n')
}

// 批量规划 prompt：输入是文件清单文本（scanRepoFiles 的 path+bytes），输出纯 JSON 计划。
// keepInMemory 任务——结果由服务侧 parsePlan 消费，不落盘。
function batchPlannerPrompt(fileLines) {
  return [
    '你是代码结构勘探员。下面是一个仓库的全部源码文件清单（路径 + 字节数）。',
    '按逻辑模块分组（模块要切小，一个模块 3-8 个文件为宜），并识别真正跨模块的概念。',
    '只输出一个 JSON 对象——禁止 markdown 围栏、禁止任何解释文字：',
    '{',
    '  "project": "<一句话项目定位>",',
    '  "modules": [ {"name": "kebab-case-name", "summary": "2-3 句话", "files": ["相对路径", "..."]} ],',
    '  "concepts": [ {"name": "kebab-case-name", "files": ["相对路径"]} ]',
    '}',
    '要求：',
    '- modules 的 files 并集必须覆盖清单里全部文件；每个文件恰好归入一个模块',
    '- 只用清单里出现的路径，不得发明清单外的文件',
    '- concepts 只收真正跨模块的模式（错误处理、数据流、认证、配置加载等），没有就给空数组',
    '- name 用小写 kebab-case，作为文章文件名',
    '',
    '文件清单：',
    fileLines,
  ].join('\n')
}

// 本地规划兜底：批量规划失败/解析不出 JSON 时按顶层目录分组。宁可粗也不中断整条流水线。
export function localPlan(files) {
  const groups = new Map()
  for (const f of files) {
    const top = f.path.split('/')[0]
    const name = slugify(top === f.path ? 'root' : top)
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(f.path)
  }
  return {
    project: '（本地兜底规划：按顶层目录分组）',
    modules: [...groups.entries()].map(([name, fs_]) => ({ name, summary: `${name} 目录下的源码`, files: fs_ })),
    concepts: [],
  }
}

// 横切输入装配：整篇装填成功文章；装不下的装头部（frontmatter + Overview 段）并标注截断。
// articles: [{name, text}]；预算按 token 计（与批量单请求同预算）。
export function packArticles(articles, budget = BATCH_TOKEN_BUDGET) {
  const parts = []
  let used = 0
  for (const a of articles) {
    let text = a.text
    const size = estimateTokens(text)
    if (used + size > budget && parts.length) {
      const head = text.slice(0, Math.max(0, text.indexOf('## Key Components')))
      const headSize = estimateTokens(head)
      if (used + headSize <= budget) {
        parts.push(`#### ${a.name}（超预算，仅头部）\n\n${head}`)
        used += headSize
      }
      continue
    }
    parts.push(`#### ${a.name}\n\n${text}`)
    used += size
  }
  return parts.join('\n\n')
}

function crosscutIntro(language, what, requirements) {
  return [
    `你是 CodeWiki 横切文章作者。文章全文用${language}书写。`,
    '',
    `任务：${what}`,
    '',
    requirements,
    '',
    '直接输出完整文章：以 --- frontmatter 开始（title/type/source_files/tags）。',
    '只输出文章本身——禁止用 markdown 代码围栏整体包裹、禁止任何解释文字。',
    'source_files 列出你实际依据的下文模块文章 frontmatter 里出现的源文件（POSIX 相对路径）。',
  ].join('\n')
}

function batchArchitecturePrompt(language, articlesText) {
  return crosscutIntro(
    language,
    `基于下文全部模块文章，写系统总览 _architecture.md。必须含三张 UTF-8 box-drawing 图（┌ ┐ └ ┘ ─ │ ► ◄ ▼）放进 \`\`\`text 围栏：System Overview 总框图、Request/Data Flow 数据流、Dependency Graph 依赖方向，说明各模块职责与相互连接。frontmatter type: architecture。章节：## Overview / ## System Overview / ## Data Flow / ## Dependency Graph / ## Module Roles。`,
    '行号可以引用模块文章中的行号；Markdown 规范；写给零上下文的未来 agent。',
  ) + `\n\n以下全部模块文章：\n\n${articlesText}`
}

function batchPatternsPrompt(language, articlesText) {
  return crosscutIntro(
    language,
    '基于下文全部模块文章，总结仓库反复出现的模式 _patterns.md（命名约定、错误处理风格、构建/测试流程、目录约定等，每模式一节并给出处）。frontmatter type: pattern。章节：## Overview / ## Patterns。',
    '每个模式必须引用具体模块文章中出现的文件/函数名作为证据。',
  ) + `\n\n以下全部模块文章：\n\n${articlesText}`
}

function batchConceptPrompt(language, concept, articlesText) {
  return crosscutIntro(
    language,
    `基于下文模块文章，写跨模块概念「${concept}」一篇专文。讲清该概念涉及哪些模块、数据/控制如何在它们之间流动、实现位置（文件:行号）。frontmatter type: concept，title 用该概念名。章节：## Overview / ## Involved Modules / ## Flow / ## Implementation Map。`,
    '只依据下文模块文章，不得发明未出现的文件。',
  ) + `\n\n以下全部模块文章：\n\n${articlesText}`
}

// 模块观察 prompt（横切 map 阶段）：每篇模块文章一个小任务，输出紧凑观察。
// 输出刻意不带 frontmatter——观察批不走 tally 落盘，只在合成批拼包。
function batchObservePrompt(language, moduleName, articleText) {
  return [
    `你是 CodeWiki 架构观察员。观察全文用${language}书写。`,
    '',
    `任务：通读下文模块「${moduleName}」的完整文章，输出该模块的架构观察（紧凑 markdown）。必含：`,
    '1. 模块职责（一句话）；',
    '2. 对外接口/入口：函数、类、路由名 + 文中行号；',
    '3. 依赖方向：依赖哪些模块、被谁依赖（从文中引用推断）；',
    '4. 值得进入系统总览的模式、约定或风险；',
    '5. `source_files:` 原样列出文章 frontmatter 里的源文件（POSIX 相对路径）。',
    '',
    '只输出观察正文——禁止 frontmatter、禁止用代码围栏整体包裹。',
    '',
    `### ${moduleName}`,
    '',
    articleText,
  ].join('\n')
}

// 文章分割观察 prompt（模块源码超单请求预算时）：一批源码 → 该批源码的紧凑技术观察。
// 与横切观察不同，这里观察对象是源码而非文章，输出要保留写文章所需的全部细节。
function batchArticleObservePrompt(language, moduleName, sourcesText, batchIndex, batchTotal) {
  return [
    `你是 CodeWiki 文章观察员。观察全文用${language}书写。`,
    '',
    `任务：模块「${moduleName}」的源码量大，已按文件分成 ${batchTotal} 批（本批为第 ${batchIndex + 1} 批）。`,
    '通读下文本批源码，输出紧凑而完整的技术观察（markdown），供后续不看源码直接写整篇模块文章。必含：',
    '1. 本批每个文件的职责与关键实现（保留全部函数/类/导出名、重要常量与默认值、关键行号——行号以源码「行号| 」前缀为准，禁止自行数行）；',
    '2. 文件间调用关系与数据流（谁调用谁、入参/返回值形状）；',
    '3. 错误处理、边界条件与非显然行为；',
    '4. 本批文件清单（POSIX 相对路径）。',
    '',
    '要求：宁全勿简——被你省略的细节合成阶段将永远缺失；但禁止贴大段源码，引用「文件:行号」（行号以源码「行号| 」前缀为准）即可。',
    '只输出观察正文——禁止 frontmatter、禁止用代码围栏整体包裹。',
    '',
    sourcesText,
  ].join('\n')
}

// 文章分割合成 prompt：全部批次观察（+可选旧文）→ 完整模块文章。
// 输入体积 = 各批观察之和，远小于原始源码，天然不超单请求预算。
function batchArticleComposePrompt({ language, mission, moduleName, observationsText, prevArticle }) {
  const parts = [
    `你是 CodeWiki 文章作者。文章全文用${language}书写。`,
    '',
    `任务：${mission}`,
    '',
    `模块「${moduleName}」源码量大，已由多个观察员分批通读并产出观察。以下观察覆盖该模块全部源码：`,
    '',
    observationsText,
  ]
  if (prevArticle) {
    parts.push(
      '',
      '这篇文章的当前内容（基于旧版代码，供保留章节结构与 title/type/tags；其中引用的行号可能已过期，一律不得沿用，行号必须按源码「行号| 」前缀重新标注）：',
      '',
      prevArticle,
    )
  }
  parts.push(
    '',
    '只依据上述观察写完整文章；观察中引用的「文件:行号」直接沿用，不得发明未出现的文件或符号。',
    '直接输出完整文章：以 --- frontmatter 开始（title/type/source_files/tags），',
    'source_files 汇总各批观察列出的全部源文件（POSIX 风格相对路径）。',
    '只输出文章本身——禁止用 markdown 代码围栏整体包裹、禁止任何解释文字。',
    '',
    articleFormatSection(),
  )
  return parts.join('\n')
}

// 批量校对 prompt：输入=文章全文+source_files 源码，输出=修正后整文（服务侧校验后才落盘）。
// 行号抽查这类机械核对由模型一次完成，不再需要多轮工具的审校智能体。
function batchProofreadPrompt({ language, articleText, sourcesText }) {
  return [
    `你是 CodeWiki 审校员。文章全文用${language}书写。`,
    '',
    '任务：核对下文 wiki 文章与源码的一致性，输出修正后的完整文章。',
    '核对项：',
    '1. frontmatter 必有 title/type/source_files/tags，source_files 与正文实际引用一致',
    '2. 抽查文中全部函数/类名与行号（上源码逐个核对；行号以源码「行号| 」前缀为准，禁止自行数行）：名字错改名字、行号错改行号、归属错改归属',
    '3. 重大源码文件被引用但未列入 source_files 的，补进 frontmatter',
    '4. 与源码不符的描述段落直接改写',
    '',
    '只输出修正后的完整文章（以 --- frontmatter 开始）——禁止围栏整体包裹、禁止解释文字。',
    '文章与源码一致时也输出全文原样（不做无谓改写）。',
    '',
    '==== 待校对文章 ====', '',
    articleText, '',
    '==== source_files 对应源码 ====', '',
    sourcesText,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 工具 1：cw CLI 封装
// ---------------------------------------------------------------------------

function cwToolDefinition(cfg) {
  return {
    name: 'cw',
    description: [
      '运行 CodeWiki CLI（cw）查询/维护当前仓库的代码 wiki。wiki 落在仓库内 <repo>/.codewiki/（随仓库提交）。',
      '常用调用：args=["status"] 查新态（三态判定）；["init"] 初始化；["index"] 重建索引；["meta","update"] 记录编译基线 commit；["path"] 打印本仓库 wiki 目录（<repo>/.codewiki）；["projects"] 只列出 ~/.codewiki 旧位置的项目（现在 wiki 在各仓库内，一般用不到）。',
      '写文章、编译 wiki 请用 codewiki_generate（后台批量流水线服务），不要用本工具手写文章。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '仓库绝对路径（git 仓库根或子目录；Windows 支持 C:/... 与 Git-Bash /c/... 形式）' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'cw 子命令与参数，如 ["status"]、["init"]、["meta","update"]',
        },
      },
      required: ['cwd', 'args'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          command: { type: 'string' },
          exitCode: { type: 'number' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          timedOut: { type: 'boolean' },
        },
        required: ['cwd', 'command', 'exitCode', 'stdout', 'stderr'],
      },
      render(args, value) {
        const head = `cw ${value.command}（exit ${value.exitCode}${value.timedOut ? '，超时' : ''}）`
        const body = [value.stdout, value.stderr].filter(Boolean).join('\n').trim()
        return [{ type: 'text', text: body ? `${head}\n${body}` : head }]
      },
    },
    execute: async (args, exec) => {
      const c = liveConfig(cfg)
      if (!c.enabled) throw new Error('cw：插件已在设置中停用（codewiki → enabled）')
      const cwd = normalizeCwd(args.cwd)
      if (!cwd || !fs.existsSync(cwd)) throw new Error(`cw：cwd 不存在：${args.cwd ?? ''}`)
      const argv = (Array.isArray(args.args) ? args.args : []).map(String).filter((s) => s.length > 0)
      if (!argv.length) throw new Error('cw：args 不能为空，例如 ["status"]')
      if (!CW_SUBCOMMANDS.includes(argv[0])) {
        throw new Error(`cw：未知子命令 "${argv[0]}"，允许：${CW_SUBCOMMANDS.join(' / ')}`)
      }
      const binary = resolveBinary(c)
      const r = await runCw(binary, cwd, argv, 120000, exec?.signal)
      if (r.timedOut) throw new Error(`cw：执行超时（120s）—— ${argv.join(' ')}`)
      return {
        cwd,
        command: argv.join(' '),
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: false,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 工具 2：codewiki_generate 编排
// ---------------------------------------------------------------------------

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9\-_]+/g, '-').replace(/^-+|-+$/g, '') || 'module'
}

function parsePlan(text) {
  if (!text) return null
  let t = String(text).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    const plan = JSON.parse(t.slice(s, e + 1))
    if (!Array.isArray(plan.modules)) return null
    plan.modules = plan.modules.filter((m) => m && typeof m.name === 'string' && Array.isArray(m.files) && m.files.length > 0)
    if (!plan.modules.length) return null
    if (!Array.isArray(plan.concepts)) plan.concepts = []
    plan.concepts = plan.concepts.filter((c) => c && typeof c.name === 'string')
    if (typeof plan.project !== 'string') plan.project = ''
    return plan
  } catch {
    return null
  }
}

// 读文章 frontmatter 的 source_files（缩进列表或行内数组），供 stale 流程取文件清单。
// 从 frontmatter 文本解析 source_files 清单（inline [a,b] 与 block - a 两式），返回相对路径数组
function parseSourceFiles(fm) {
  const inline = fm.match(/^source_files:\s*\[([^\]]*)\]/m)
  if (inline) {
    return inline[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  }
  const block = fm.match(/^source_files:\s*$(?:\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)+))/m)
  if (block) {
    return block[1].split(/\r?\n/)
      .map((l) => l.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }
  return []
}

function readSourceFiles(articlePath) {
  try {
    const raw = fs.readFileSync(articlePath, 'utf8')
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    return m ? parseSourceFiles(m[1]) : []
  } catch {
    return []
  }
}

async function wikiPathFor(cwd, binary, signal) {
  const r = await runCw(binary, cwd, ['path'], 30000, signal)
  const p = (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop()
  if (r.exitCode === 0 && p) return p
  return path.join(cwd, '.codewiki') // 与 wiki_path() 一致：wiki 在仓库内
}

// ---------------------------------------------------------------------------
// 编排服务：全批量流水线（零子代理）
// codewiki_generate 只判态与提交；服务以 10s tick 推进各 job 的阶段机：
//   full   = plan → articles → crosscut →（超预算拆分时 compose）→ review → index
//   stale  = articles（任务在提交时预构建）→ review → index
// 全部模型调用都是单轮文本生成，统一走百炼普通入口（chat/completions）后台并发池；单文件超
// 32k 预算先升 200k 大档重装继续，仍装不下才跳过该任务（bailianChat）。规划/横切/校对结果
// keepInMemory，服务侧校验 frontmatter 后才落盘，坏输出不写 wiki。
// ---------------------------------------------------------------------------

// 测试可设 DSH_CODEWIKI_JOBS_FILE 隔离到独立路径——默认路径与真实宿主实例共享，
// 宿主周期 flush 会用其内存副本整写同一文件，测试期间互相洗掉对方的内存字段（tps 采样 flaky 的根因）
const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE || path.join(os.tmpdir(), 'dsh-codewiki-jobs.json')
const TICK_MS = Math.max(250, Number(process.env.DSH_CODEWIKI_TICK_MS) || 10000)
// 孤儿接管阈值：另一实例的 job 停更超过该时长视为宿主重启遗留，本实例接管推进
const ORPHAN_TAKEOVER_MS = Math.max(60000, Number(process.env.DSH_CODEWIKI_ORPHAN_TAKEOVER_MS) || 5 * 60 * 1000)
const MAX_JOBS_KEPT = 30

// 已知仓库清单：独立于 job 历史的持久化工作区登记。job 记录会被 MAX_JOBS_KEPT 截断、
// Temp 沙箱任务会被启动清理移除，仓库总览若只扫 job 历史就会漏掉编译过的工作区
// ——提交过一次就永久登记（hindsight recentWorkspaces 同思路），与 JOBS_FILE 同目录同生命周期。
const REPOS_FILE = process.env.DSH_CODEWIKI_REPOS_FILE || path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-repos.json')
function loadKnownRepos() {
  try { return JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'))?.repos ?? [] } catch { return [] }
}
function rememberRepo(cwd) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return
  const key = (p) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase()
  const list = loadKnownRepos()
  if (list.some((p) => key(p) === key(dir))) return
  list.push(dir)
  try { fs.writeFileSync(REPOS_FILE, JSON.stringify({ repos: list }, null, 2), 'utf8') } catch { /* 不可写则放弃 */ }
}
const JOB_TERMINAL = new Set(['done', 'failed', 'cancelled'])

// 仓库源码勘探（规划输入）：黑名单目录 + 二进制后缀 + 单文件 256KB + 总数 2000
const SCAN_SKIP_DIRS = new Set([
  '.git', '.codewiki', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target',
  '.next', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'bin', 'obj',
  '.gradle', 'Pods', 'coverage', '.nyc_output', 'tmp', 'logs',
])
const SCAN_SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.zip', '.gz',
  '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj',
  '.a', '.lib', '.class', '.jar', '.pyc', '.pyo', '.woff', '.woff2', '.ttf', '.otf',
  '.eot', '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.db', '.sqlite', '.wasm', '.node', '.map',
])
const SCAN_MAX_FILE_BYTES = 256 * 1024
const SCAN_MAX_FILES = 2000

export function scanRepoFiles(cwd) {
  const out = []
  const walk = (dir, rel) => {
    if (out.length >= SCAN_MAX_FILES) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= SCAN_MAX_FILES) return
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        walk(path.join(dir, e.name), r)
      } else if (e.isFile()) {
        if (SCAN_SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue
        let st
        try { st = fs.statSync(path.join(dir, e.name)) } catch { continue }
        if (st.size === 0 || st.size > SCAN_MAX_FILE_BYTES) continue
        out.push({ path: r, bytes: st.size })
      }
    }
  }
  walk(cwd, '')
  return out
}

function loadJobs() {
  const j = readJsonFile(JOBS_FILE)
  return Array.isArray(j?.jobs) ? j.jobs : []
}

const JOBS_LOCK_FILE = `${JOBS_FILE}.lock`
// 跨进程推进锁：两个宿主窗口各跑一个服务实例，同时推进同一 job 会双提交批量。
// 崩溃残留锁 60s 过期强删——tick 间隔 10s，60s 足够宽限。
function acquireTickLock() {
  try {
    fs.writeFileSync(JOBS_LOCK_FILE, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    try {
      if (Date.now() - fs.statSync(JOBS_LOCK_FILE).mtimeMs > 60000) {
        fs.unlinkSync(JOBS_LOCK_FILE)
        fs.writeFileSync(JOBS_LOCK_FILE, String(process.pid), { flag: 'wx' })
        return true
      }
    } catch { /* 锁刚被别的实例释放：本轮让路 */ }
    return false
  }
}
function releaseTickLock() { try { fs.unlinkSync(JOBS_LOCK_FILE) } catch { /* 已被清理 */ } }

function saveJobs(jobs) {
  // 只留最近 30 个；apiKey 不落盘（重启后按需重解析），cancelRequested 必须落盘（取消标记靠它跨 tick 存活）
  const kept = jobs.slice(-MAX_JOBS_KEPT).map(({ apiKey, ...rest }) => rest)
  try { fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: kept }, null, 2), 'utf8') } catch { /* tmp 不可写则放弃持久化 */ }
}

function jobSummary(job) {
  // tps：最近任务样本的聚合（总输出 token / 总生成毫秒），尚无完成任务时为 null
  const samples = job.tpsSamples ?? []
  const tok = samples.reduce((a, x) => a + (x.outputTokens ?? 0), 0)
  const ms = samples.reduce((a, x) => a + (x.durationMs ?? 0), 0)
  return {
    id: job.id,
    cwd: job.cwd,
    kind: job.kind,
    scope: job.scope,
    auto: job.auto === true,
    stage: job.stage,
    batchId: job.batchRef?.batchId ?? null,
    writtenCount: job.writtenCount,
    failedCount: job.failedCount,
    cancelRequested: job.cancelRequested === true,
    articles: (job.articles ?? []).map((a) => ({ name: a.name, ok: a.ok })),
    // 全程任务明细：已结算（done/failed）在前，当前批次待办（pending）在后；进度条分母即其长度
    taskList: [
      ...(job.articles ?? []).map((a) => ({ name: a.name, state: a.ok ? 'done' : 'failed' })),
      ...(() => { const settled = new Set((job.articles ?? []).map((a) => a.name)); return (job.tasks ?? []).filter((t) => !settled.has(t.name)).map((t) => ({ name: t.name, state: 'pending' })) })(),
    ],
    batchProgress: job.batchProgress ?? null,
    batchSubmittedAt: job.batchSubmittedAt ?? null,
    stageStartedAt: job.stageStartedAt ?? null,
    stageTimings: job.stageTimings ?? null,
    usage: job.usage ?? null,
    notes: (job.notes ?? []).slice(-8),
    error: job.error ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt ?? null,
    tps: ms > 0 ? Math.round((tok / ms) * 10000) / 10 : null,
  }
}

// ---------------------------------------------------------------------------
// 编译终态实时唤醒：对发起会话 steer 一条消息（与子代理 send_message 同机制，纯插件侧
// 现有 API，零 IPC）。agentsRef 由 apply() 经 ctx.inject(['agents']) 赋值；无 agent 上下文
// （面板/自动调度提交）与冷会话（会话已关）一律静默跳过——系统提示 section 拉取仍兜底。
// ---------------------------------------------------------------------------
let agentsRef = null

// llm 服务引用：cordis 严格语义下直接访问 ctx.llm 会抛「cannot get property "llm"
// without inject」（0.8.5 前的 typeof 守卫拦不住），规划阶段因此全程降级百炼。
// 与 agentsRef 同款：apply 时经 ctx.inject(['llm']) 在注入时取服务。
let llmRef = null

export function wakeCompileSession(job, outcome, agents = agentsRef) {
  if (!job?.sessionId || !agents || typeof agents.get !== 'function') return
  let agent
  try { agent = agents.get(job.sessionId) } catch { return }
  if (!agent || typeof agent.steer !== 'function') return
  const text = outcome === 'failed'
    ? `【CodeWiki 编译失败】任务 ${job.id}（${job.cwd}）失败：${job.error ?? '未知原因'}——可用 codewiki_progress 查详情，处理后重新提交。`
    : `【CodeWiki 编译完成·请提交改动】任务 ${job.id} 已完成（写入 ${job.writtenCount} 篇文章）：检查 .codewiki/ 与 CodeWiki.md 的未提交改动并提交（只 add 这两个路径，建议 docs(wiki) 前缀；不要 git add -A）；已入库或无需提交则忽略本消息。`
  try {
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin:codewiki' } }))
  } catch { /* 唤醒失败不影响编译任务本身 */ }
}

function createJobService(config, onSettled) {
  const jobs = loadJobs()
  for (const j of jobs) rememberRepo(j.cwd) // 一次性种子：旧历史进已知仓库清单
  let timer = null
  let ticking = false
  let seq = 0
  // 实例身份：tick 只推进本实例创建的 job（owner 缺失=0.4.2 残留，任何实例可接管续查）。
  // 否则另一实例的 tick 会用 loadJobs 旧快照重复推进同一 job——双提交批量。
  const instanceId = `svc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // 脏标记：只有任务状态变更过才整写 JOBS_FILE。多实例并存时（插件重载/测试重复 apply），
  // 无事可做的旧实例不会用自己的过期快照覆盖新实例的活动 job。
  let dirty = false
  // 本实例改过的 job id：flush 合并时这些 job 的内存对象是唯一现场（可能比磁盘新），
  // 不允许被磁盘快照反向覆盖——否则 cancel/fail 与慢 tick 交错时会丢掉现场新增的 note/batchRef。
  const dirtyIds = new Set()
  const persist = () => { dirty = true }
  // Temp 沙箱残留清理：cwd 位于系统临时目录的终态任务（调试/测试期产物）启动即移除，
  // 活动任务保留（可能是真实编译）；面板端点直接受益，无需逐个手工取消。
  {
    const tmpBase = path.normalize(os.tmpdir()).toLowerCase()
    const kept = jobs.filter((j) => !(
      j.cwd && path.normalize(j.cwd).toLowerCase().startsWith(tmpBase) &&
      ['done', 'failed', 'cancelled'].includes(j.stage)
    ))
    if (kept.length !== jobs.length) {
      jobs.length = 0
      jobs.push(...kept)
      saveJobs(jobs) // 立即落盘：仅 persist 标脏的话，tick 的 mergeFromDisk 会把磁盘残留吸回内存
    }
  }
  // 磁盘吸收：另一实例新增的 job、或同 id 但磁盘更新且本实例没动过的 job，并回内存——
  // 防止 flush 用本实例的过期快照覆盖掉对方的活动 job。
  function mergeFromDisk() {
    const disk = loadJobs()
    if (!disk.length) return
    const mine = new Map(jobs.map((j) => [j.id, j]))
    let changed = false
    for (const theirs of disk) {
      const m = mine.get(theirs.id)
      if (m) {
        if (!dirtyIds.has(theirs.id) && (theirs.updatedAt ?? '') > (m.updatedAt ?? '')) {
          mine.set(theirs.id, theirs)
          changed = true
        }
        continue
      }
      mine.set(theirs.id, theirs)
      changed = true
    }
    if (!changed) return
    const merged = [...mine.values()].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    jobs.length = 0
    jobs.push(...merged)
  }
  const flush = () => {
    if (!dirty) return
    mergeFromDisk(); dirty = false; dirtyIds.clear(); saveJobs(jobs)
  }
  const note = (job, msg) => {
    ;(job.notes ??= []).push(msg) // 磁盘残留/手工构造的 job 可能缺 notes，防御性补齐
    if (job.notes.length > 50) job.notes = job.notes.slice(-50)
  }
  // touch = 状态变更的统一入口：必须标脏，否则 tick 末 flush 跳过、取消等纯内存
  // 变更（touch 后 continue，绕过终态 persist）永远进不了 JOBS_FILE
  const touch = (job) => {
    job.updatedAt = new Date().toISOString(); dirty = true; dirtyIds.add(job.id)
  }
  // 阶段切换统一入口：累计各阶段耗时并记录当前阶段起始时刻（面板步骤条/耗时展示用）。
  // 旧任务/测试构造的 job 无 stageStartedAt 时只切阶段不记时。
  const setStage = (job, stage) => {
    if (job.stage && job.stageStartedAt) {
      const ms = Date.now() - Date.parse(job.stageStartedAt)
      if (Number.isFinite(ms) && ms > 0) {
        job.stageTimings = { ...(job.stageTimings ?? {}), [job.stage]: (job.stageTimings?.[job.stage] ?? 0) + ms }
      }
    }
    job.stage = stage
    job.stageStartedAt = new Date().toISOString()
    touch(job)
  }
  // 用量累计：输入为提交时估算（estimateTokens），输出为响应回传 usage 实测。
  const addUsage = (job, { inputTok = 0, outputTok = 0, requests = 0, batch = false, realtime = false, overTier2 = 0 } = {}) => {
    job.usage ??= { inputTok: 0, outputTok: 0, requests: 0, batchRequests: 0, realtimeRequests: 0, overTier2: 0 }
    job.usage.inputTok += inputTok
    job.usage.outputTok += outputTok
    job.usage.requests += requests
    job.usage.batchRequests += batch ? requests : 0
    job.usage.realtimeRequests += realtime ? requests : 0
    job.usage.overTier2 += overTier2
    touch(job)
  }

  // 跨实例取消：另一实例 cancel 的 job 不在本实例内存现场（dirtyIds 之外才允许被磁盘覆盖，
  // 但本实例若正在推进它，内存对象永远不被磁盘覆盖）——每轮 tick 开头从磁盘拾取取消标记。
  function syncCancelFlags() {
    const disk = loadJobs()
    if (!disk.length) return
    for (const j of jobs) {
      if (JOB_TERMINAL.has(j.stage) || j.cancelRequested) continue
      const theirs = disk.find((d) => d.id === j.id)
      if (theirs?.cancelRequested === true) {
        j.cancelRequested = true
        dirty = true
      }
    }
  }

  function fail(job, msg) {
    const fromSubmit = job.stage === 'submitting' // 提交期失败：错误随工具调用同步返回，无需再唤醒
    setStage(job, 'failed')
    job.error = msg
    job.finishedAt = new Date().toISOString()
    note(job, `任务失败：${msg}`)
    touch(job)
    if (!fromSubmit) onSettled?.(job, 'failed') // sessionId 守卫在 wakeCompileSession 内
  }

  // 凭证：内存缓存优先；不落盘，重启后重解析（凭证库可能已就绪/已更换）
  async function apiKeyOf(job) {
    if (job.apiKey) return job.apiKey
    const k = await resolveBatchApiKey(hostCtxRef, liveConfig(config))
    if (!k) throw new Error(`未找到百炼凭证（原解析来源 ${job.credentialSource ?? '未知'}），任务无法继续——可在插件设置填 batchApiKey 后重新提交`)
    job.apiKey = k.key
    job.credentialSource = k.source
    return k.key
  }

  // 阶段收割统一入口：返回 null = 阶段还在跑，下轮 tick 再看。
  async function settleJob(job) {
    // 执行器（后台并发池）：结果进 batchResults 等收割；null = 执行器整体失败（已 fail）
    if (batchResults.has(job.id)) {
      const rs = batchResults.get(job.id)
      batchResults.delete(job.id)
      if (rs) { job.batchProgress = null; job.batchSubmittedAt = null } // 已收割，中间进度作废
      return rs ?? []
    }
    if (batchRuns.has(job.id)) return null // 执行器在跑
    // 执行器丢失（宿主重启）：请求随连接生死，无法续查——按 job.tasks
    // 持久化的 batchPrompt 快照重跑本阶段，是唯一恢复路径（幂等：文章重写覆盖）。
    const tasks = job.tasks ?? []
    const runnable = tasks.filter((t) => typeof t.batchPrompt === 'string' && t.batchPrompt.length)
    if (runnable.length && runnable.length === tasks.length) {
      note(job, `执行器丢失（宿主重启），自动重跑阶段 ${job.stage}（${tasks.length} 个请求）`)
      job.batchProgress = { completed: 0, total: tasks.length }
      startBatchChatRun(job, tasks)
      return null
    }
    fail(job, '请求因宿主重启丢失且无法重跑（任务缺少 prompt 快照），请重新提交')
    return null
  }

  // keepInMemory 结果的落盘闸门：输出必须以 frontmatter 开头，坏输出不写 wiki。
  // keepInMemory 任务（横切/校对）在批量阶段不落盘，唯一写盘点在这里——
  // 不能再走 applyTaskResult（它对 keepInMemory 只回内存不落盘）。
  function writeValidated(job, task, content) {
    if (typeof content !== 'string' || !content.trimStart().startsWith('---')) {
      note(job, `${task.name}：模型输出缺 frontmatter，不落盘（原文件保留）`)
      return { name: task.name, ok: false, stopReason: 'invalid' }
    }
    try {
      fs.mkdirSync(path.dirname(task.articlePath), { recursive: true })
      const fx = fixAnchors(content, job.cwd)
      if (fx.fixed > 0) note(job, `${task.name}：自动修正 ${fx.fixed} 处行号锚点`)
      if (fx.unresolved.length) note(job, `${task.name}：行号锚点存疑（未改）—— ${fx.unresolved.slice(0, 3).join('；')}${fx.unresolved.length > 3 ? ' 等' : ''}`)
      fs.writeFileSync(task.articlePath, fx.text, 'utf8')
      return { name: task.name, ok: true, stopReason: 'completed' }
    } catch (err) {
      note(job, `文章 ${task.name} 落盘失败 —— ${String(err?.message ?? err)}`)
      return { name: task.name, ok: false, stopReason: 'error' }
    }
  }

  // 结果记账；replace=true 时校对结果覆盖同名文章条目（校对失败不推翻已写成功的原文）
  function tally(job, results, tasks, { replace = false } = {}) {
    const byName = new Map((tasks ?? job.tasks ?? []).map((t) => [t.name, t]))
    for (const r of results) {
      const t = byName.get(r.name)
      let entry
      if (t?.keepInMemory && r.ok) {
        entry = writeValidated(job, t, r.content)
      } else {
        entry = { name: r.name, ok: r.ok === true, stopReason: r.stopReason }
      }
      const rec = { name: entry.name, ok: entry.ok, stopReason: entry.stopReason, path: t?.articlePath ?? null }
      const prev = replace ? job.articles.find((a) => a.name === rec.name) : null
      if (prev) {
        if (!rec.ok && prev.ok) rec.ok = true
        Object.assign(prev, rec)
      } else {
        job.articles.push(rec)
        if (rec.ok) job.writtenCount += 1
        else job.failedCount += 1
      }
    }
  }

  // 阶段执行器：后台并发池打百炼普通入口，结果进 batchResults 由 settleJob 收割，
  // tick 不被长请求阻塞。batchRuns 是存活性标记，batchAborters 供取消中断在飞请求。
  const batchRuns = new Map()     // jobId → 执行器 Promise
  const batchResults = new Map()  // jobId → results[]（null = 执行器整体失败，已 fail）
  const batchAborters = new Map() // jobId → AbortController
  function startBatchChatRun(job, prepared) {
    const c = liveConfig(config)
    const ac = new AbortController()
    batchAborters.set(job.id, ac)
    let doneCount = 0
    const run = apiKeyOf(job)
      .then((apiKey) => runRealtimeTasks(prepared, {
        apiKey,
        model: c.batchModel,
        thinkingBudget: c.batchThinkingBudget,
        concurrency: c.maxConcurrency,
        notes: job.notes,
        signal: ac.signal,
        onTaskDone: (s) => {
          doneCount += 1
          job.batchProgress = { completed: doneCount, total: prepared.length }
          job.tpsSamples = [...(job.tpsSamples ?? []), s].slice(-20)
          addUsage(job, { outputTok: s.outputTokens ?? 0 }) // 输出 token 实测入账
          touch(job)
        },
      }))
      .then(
        (rs) => batchResults.set(job.id, [...rs.values()]),
        (err) => {
          batchResults.set(job.id, null)
          if (!JOB_TERMINAL.has(job.stage)) {
            const msg = `阶段执行失败 —— ${String(err?.message ?? err)}`
            note(job, msg)
            fail(job, msg)
          }
        },
      )
      .finally(() => {
        batchRuns.delete(job.id); batchAborters.delete(job.id)
        if (JOB_TERMINAL.has(job.stage)) batchResults.delete(job.id) // 取消/失败后不残留未收割结果
        touch(job)
      })
    batchRuns.set(job.id, run)
    return run
  }

  function submitBatchFor(job, prepared) {
    const c = liveConfig(config)
    // 请求实际输入超 32k 档的按 3 倍价计费，提交前明示
    const tier2 = prepared.filter((t) => estimateTokens(t.batchPrompt) > BATCH_TOKEN_BUDGET).length
    addUsage(job, { inputTok: prepared.reduce((n, t) => n + estimateTokens(t.batchPrompt), 0), requests: prepared.length, realtime: true, overTier2: tier2 })
    if (tier2) note(job, `${tier2} 个请求输入超 32k 档，按 3 倍价计费`)
    job.batchRef = { batchId: `stage-${job.id}` } // 无服务端批次 id，仅标记「阶段在途」
    job.batchSubmittedAt = new Date().toISOString() // 面板执行时长计时起点，收割时清空
    job.tasks = prepared.map((t) => ({
      customId: t.customId, name: t.name, articlePath: t.articlePath, keepInMemory: t.keepInMemory === true,
      cwd: t.cwd, // 锚点自动修正的源码根（writeValidated 用 job.cwd，普通文章直写用 t.cwd）
      batchPrompt: t.batchPrompt, // 宿主重启后重跑本阶段的唯一依据
      // 分割观察任务（#obs）的合成重建元数据：splitFor 指向所属文章 name，
      // composePlan 携带 mission/articlePath/prevArticlePath——收割时从持久化快照重建合成任务
      ...(t.splitFor ? { splitFor: t.splitFor, composePlan: t.composePlan } : {}),
    }))
    job.batchProgress = { completed: 0, total: prepared.length }
    startBatchChatRun(job, prepared)
    note(job, `阶段已启动：${prepared.length} 个请求（模型 ${c.batchModel}，并发 ${c.maxConcurrency}）`)
    touch(job)
  }

  // ---- 阶段处理：每 tick 每 job 推进一步 ----

  async function tickPlan(job) {
    if (job.batchRef) {
      const results = await settleJob(job)
      if (results === null) return
      const planResult = results.find((r) => r.ok && r.content)
      let plan = planResult ? parsePlan(planResult.content) : null
      if (!plan) {
        note(job, '批量规划未产出可用 JSON，降级本地按顶层目录分组')
        plan = localPlan(scanRepoFiles(job.cwd))
      }
      job.plan = plan
      note(job, `规划：${plan.modules.length} 个模块、${plan.concepts.length} 个概念${plan.project ? `（${plan.project}）` : ''}`)
      job.batchRef = null
      job.tasks = []
      setStage(job, 'articles')
      return
    }
    const files = scanRepoFiles(job.cwd)
    if (!files.length) { fail(job, '仓库没有可编译的源码文件'); return }
    const fileLines = files.map((f) => `- ${f.path}（${f.bytes}B）`).join('\n')
    const prompt = batchPlannerPrompt(fileLines)
    // 主模型规划：发起会话 agent 可用且能解析其当前路由时走 ctx.llm（无 32k 低价档
    // 限制，避免整份文件清单超档按 3 倍价；主模型也不占百炼并发池）。失败降级百炼批量。
    const main = await runMainModelPlan(job, prompt)
    if (main !== null) {
      const plan = parsePlan(main)
      if (plan) {
        job.plan = plan
        note(job, `规划（主模型）：${plan.modules.length} 个模块、${plan.concepts.length} 个概念${plan.project ? `（${plan.project}）` : ''}`)
        setStage(job, 'articles')
        return
      }
      note(job, '主模型规划未产出可用 JSON，降级百炼批量规划')
    }
    const planTask = {
      customId: 'plan', name: '_plan', keepInMemory: true,
      batchPrompt: prompt,
    }
    try {
      await submitBatchFor(job, [planTask])
    } catch (err) {
      fail(job, `规划批次提交失败 —— ${String(err?.message ?? err)}`)
    }
  }

  // 主模型规划：直接继承发起会话当前对话的模型。路由与主线 compaction 的
  // latest ?? agentTarget 同序：会话已路由的 requestHeader config 优先，未路由
  // 退回 agent.options（创建时的路由）。经宿主 llm 服务单轮流收集。
  // 返回模型输出文本；不可用（无 agent/无 llm/无路由/请求失败）返回 null 走批量回退。
  async function runMainModelPlan(job, prompt) {
    try {
      if (!job.sessionId || !agentsRef || typeof agentsRef.get !== 'function') return null
      let agent
      try { agent = agentsRef.get(job.sessionId) } catch { return null }
      const latest = agent?.session?.requestHeader?.()?.config
      const target = latest?.provider && latest?.model
        ? { provider: latest.provider, model: latest.model }
        : agent?.options?.provider && agent?.options?.model
          ? { provider: agent.options.provider, model: agent.options.model }
          : undefined
      if (!target) return null
      const { provider, model } = target
      const llm = llmRef
      if (!llm || typeof llm.stream !== 'function') {
        note(job, '主模型规划不可用（llm 服务未注入），降级百炼批量规划')
        return null
      }
      const ac = new AbortController()
      batchAborters.set(job.id, ac) // 取消编译 = 中断规划请求
      try {
        note(job, `规划走主模型（${model}），避开 32k 低价档限制`)
        addUsage(job, { inputTok: estimateTokens(prompt), requests: 1, realtime: true })
        const assembler = new BlockAssembler()
        for await (const chunk of llm.stream({
          provider,
          model,
          messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin:codewiki' } })],
          temperature: 0,
          signal: ac.signal,
        })) {
          assembler.push(chunk)
        }
        const finish = assembler.finish
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          note(job, `主模型规划流终止（${finish.kind}）—— ${String(finish.failure?.message ?? '')}`)
          return null
        }
        if (assembler.usage) addUsage(job, { outputTok: assembler.usage.outputTokens ?? 0 })
        const text = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('')
        return text || null
      } finally {
        batchAborters.delete(job.id)
        touch(job)
      }
    } catch (err) {
      note(job, `主模型规划异常 —— ${String(err?.message ?? err)}`)
      return null
    }
  }

  async function tickArticles(job) {
    if (job.batchRef) {
      const results = await settleJob(job)
      if (results === null) return
      const tasks = job.tasks
      job.batchRef = null
      job.tasks = []
      // 文章分割观察批收割：拼观察包，为每篇分割文章提交一个合成请求（keepInMemory，直写盘）
      const splitObs = results.filter((r) => r.name.includes('#obs'))
      if (splitObs.length) {
        const byArticle = new Map()
        for (const r of splitObs) {
          const articleName = r.name.slice(0, r.name.indexOf('#obs'))
          if (!byArticle.has(articleName)) byArticle.set(articleName, { batches: [], failed: 0 })
          const slot = byArticle.get(articleName)
          if (r.ok && r.content) slot.batches.push(r.content)
          else slot.failed += 1
        }
        const composeTasks = []
        const composedArticles = new Set() // 每篇文章只重建一条合成任务（多批共享）
        for (const r of tasks) {
          if (!r.name.includes('#obs') || !r.composePlan) continue
          const articleName = r.name.slice(0, r.name.indexOf('#obs'))
          if (composedArticles.has(articleName)) continue
          composedArticles.add(articleName)
          const slot = byArticle.get(articleName)
          if (!slot) continue
          if (slot.failed >= slot.batches.length || !slot.batches.length) {
            note(job, `模块文章 ${articleName} 观察全部失败，该篇缺席本轮编译`)
            continue
          }
          if (slot.failed) note(job, `${slot.failed} 个观察批失败，合成基于剩余观察进行`)
          const plan = r.composePlan
          const prevArticle = plan.prevArticlePath
            ? (() => { try { return fs.readFileSync(plan.prevArticlePath, 'utf8') } catch { return '' } })()
            : ''
          composeTasks.push({
            customId: `${r.customId.replace(/o\d+$/, '')}c`,
            name: articleName,
            keepInMemory: true,
            articlePath: plan.articlePath,
            batchPrompt: batchArticleComposePrompt({
              language: job.language,
              mission: plan.mission,
              moduleName: articleName,
              observationsText: slot.batches.map((b, i) => `#### 观察批 ${i + 1}\n\n${b}`).join('\n\n'),
              prevArticle,
            }),
          })
        }
        if (composeTasks.length) {
          try {
            await submitBatchFor(job, composeTasks)
            note(job, `收到 ${splitObs.length} 份观察，提交 ${composeTasks.length} 个文章合成请求`)
            return
          } catch (err) {
            fail(job, `文章合成批次提交失败 —— ${String(err?.message ?? err)}`)
            return
          }
        }
        setStage(job, job.kind === 'full' ? 'crosscut' : 'review')
        return
      }
      tally(job, results, tasks)
      if (job.writtenCount === 0) { fail(job, '全部文章任务失败（wiki 基线不变，可重新提交）'); return }
      setStage(job, job.kind === 'full' ? 'crosscut' : 'review')
      return
    }
    // 组装文章任务并提交：stale 用预构建任务；full 用 job.plan；resume 不经此处（batchRef 已设）
    let tasks
    if (job.kind === 'stale') tasks = job.tasks
    else {
      const plan = job.plan
      if (!plan?.modules?.length) { fail(job, '规划没有可用模块'); return }
      tasks = plan.modules.map((mod) => {
        const slug = slugify(mod.name)
        return {
          name: `modules/${slug}.md`,
          mission: `为模块「${mod.name}」撰写文章 modules/${slug}.md${mod.summary ? `：${mod.summary}` : ''}`,
          sources: mod.files,
          cwd: job.cwd,
          articlePath: path.join(job.wikiPath, 'modules', `${slug}.md`),
          prevArticlePath: path.join(job.wikiPath, 'modules', `${slug}.md`), // 已有旧文则作上下文
        }
      })
    }
    const { prepared, oversized } = prepareArticleTasks(tasks, { cwd: job.cwd, language: job.language })
    if (oversized.length) {
      const c = liveConfig(config)
      note(job, `${oversized.length} 个任务连 ${BATCH_TOKEN_HARD_LIMIT} token 大档都装不下，转超大兜底（同模型同步调用）`)
      oversized.forEach((t, i) => { t.customId = `rt${i}` })
      addUsage(job, { inputTok: oversized.reduce((n, t) => n + estimateTokens(t.batchPrompt), 0), requests: oversized.length, realtime: true })
      const rt = await runRealtimeTasks(oversized, {
        apiKey: await apiKeyOf(job),
        model: c.batchModel,
        thinkingBudget: c.batchThinkingBudget,
        concurrency: c.maxConcurrency,
        notes: job.notes,
        onTaskDone: (s) => {
          job.tpsSamples = [...(job.tpsSamples ?? []), s].slice(-20)
          addUsage(job, { outputTok: s.outputTokens ?? 0 })
        },
      })
      tally(job, [...rt.values()], oversized)
    }
    if (prepared.length) {
      try {
        await submitBatchFor(job, prepared)
      } catch (err) {
        fail(job, `文章批次提交失败 —— ${String(err?.message ?? err)}`)
      }
      return
    }
    if (oversized.length) {
      if (job.writtenCount === 0) { fail(job, '全部文章任务失败（wiki 基线不变，可重新提交）'); return }
      setStage(job, job.kind === 'full' ? 'crosscut' : 'review')
    } else {
      fail(job, '没有可写的文章任务')
    }
  }

  // 横切合成任务（单批直出与拆分合成共用）：输入 pack = 模块文章全文或模块观察拼接
  function crosscutTasks(job, pack) {
    const lang = job.language
    return [
      {
        customId: 'arch', name: '_architecture.md', keepInMemory: true,
        articlePath: path.join(job.wikiPath, '_architecture.md'),
        batchPrompt: batchArchitecturePrompt(lang, pack),
      },
      {
        customId: 'patterns', name: '_patterns.md', keepInMemory: true,
        articlePath: path.join(job.wikiPath, '_patterns.md'),
        batchPrompt: batchPatternsPrompt(lang, pack),
      },
      ...job.plan.concepts.map((c, i) => ({
        customId: `concept${i}`, name: `concepts/${slugify(c.name)}.md`, keepInMemory: true,
        articlePath: path.join(job.wikiPath, 'concepts', `${slugify(c.name)}.md`),
        batchPrompt: batchConceptPrompt(lang, c.name, pack),
      })),
    ]
  }

  async function tickCrosscut(job) {
    if (job.batchRef) {
      const results = await settleJob(job)
      if (results === null) return
      const tasks = job.tasks
      job.batchRef = null
      job.tasks = []
      if (job.crosscutSplit) {
        // 观察批收尾：不走 tally（不写盘不计数），收观察文本拼合成批
        job.crosscutSplit = false
        const observations = []
        for (const r of results) {
          if (r.ok && r.content) observations.push({ name: r.name, text: r.content })
          else note(job, `${r.name}：模块观察失败，该模块缺席横切合成`)
        }
        if (!observations.length) {
          note(job, '全部模块观察失败，跳过横切')
          setStage(job, 'review')
          return
        }
        const pack = observations.map((o) => `#### ${o.name}\n\n${o.text}`).join('\n\n')
        note(job, `收到 ${observations.length} 份模块观察，提交横切合成批次`)
        setStage(job, 'compose')
        await submitComposeBatch(job, pack)
        return
      }
      tally(job, results, tasks)
      setStage(job, 'review')
      return
    }
    // 输入 = 成功模块文章全文（packArticles 装不下截头部并标注）
    const texts = []
    for (const a of job.articles) {
      if (!a.ok || !a.path) continue
      try { texts.push({ name: a.name, text: fs.readFileSync(a.path, 'utf8') }) } catch { /* 丢文件在横切输入缺席 */ }
    }
    if (!texts.length) { note(job, '没有成功模块文章可作横切输入，跳过横切'); setStage(job, 'review'); return }
    const lang = job.language
    // 拆分判定用原始总量——packArticles 只截后续文章头部，pack 体积永远装得下，不能作依据
    const totalTokens = texts.reduce((n, a) => n + estimateTokens(a.text), 0)
    if (totalTokens <= BATCH_TOKEN_BUDGET) {
      // 总量装得进单请求预算：单批直出，零拆分开销
      try {
        await submitBatchFor(job, crosscutTasks(job, packArticles(texts)))
        note(job, `横切批次已提交：_architecture/_patterns + ${job.plan.concepts.length} 个概念`)
      } catch (err) {
        fail(job, `横切批次提交失败 —— ${String(err?.message ?? err)}`)
      }
      return
    }
    // 精准拆分：每篇模块文章一个观察小任务（并发跑），合成批只吃观察（远小于原文，永不超限）
    const tasks = texts.map((a, i) => ({
      customId: `obs${i}`, name: `_obs/${a.name}`, keepInMemory: true,
      batchPrompt: batchObservePrompt(lang, a.name, a.text),
    }))
    job.crosscutSplit = true
    try {
      await submitBatchFor(job, tasks)
      note(job, `模块文章总量超单请求预算，横切拆为 ${tasks.length} 个观察任务并发执行，随后合成`)
    } catch (err) {
      job.crosscutSplit = false
      fail(job, `观察批次提交失败 —— ${String(err?.message ?? err)}`)
    }
  }

  // 合成批收尾：观察批已 settle，合成结果与单批路径同样走 tally 写盘
  async function tickCompose(job) {
    if (job.batchRef) {
      const results = await settleJob(job)
      if (results === null) return
      tally(job, results, job.tasks)
      job.batchRef = null
      job.tasks = []
    } else {
      // 合成批断点丢失（stage 落盘与提交落盘之间进程中断）：留痕降级，不静默
      note(job, '合成批次未落盘（上次进程中断于提交后落盘前），跳过横切进校对')
    }
    setStage(job, 'review')
  }

  function submitComposeBatch(job, observationsText) {
    // 0.6.0 起 submitBatchFor 是同步函数（返回 undefined），不能再 .then 链——改为 try/catch
    try {
      submitBatchFor(job, crosscutTasks(job, observationsText))
      note(job, `横切合成批次已提交：_architecture/_patterns + ${job.plan.concepts.length} 个概念（输入=模块观察）`)
    } catch (err) {
      // 文章已写成功，合成提交失败降级跳过横切，不推翻整个任务
      setStage(job, 'review')
      note(job, `横切合成批次提交失败，跳过横切 —— ${String(err?.message ?? err)}`)
    }
  }

  // 本地核对：frontmatter 必填 + source_files 存在性（只记账，不删文）
  function localReview(job) {
    const problems = []
    for (const a of job.articles) {
      if (!a.ok || !a.path) continue
      let text = null
      try { text = fs.readFileSync(a.path, 'utf8') } catch { text = null }
      if (text === null) {
        problems.push(`${a.name}：文件丢失`)
        a.ok = false
        a.stopReason = 'missing'
        if (job.writtenCount > 0) job.writtenCount-- // 文件已不在，成功写盘计数回退
        continue
      }
      if (!text.trimStart().startsWith('---')) { problems.push(`${a.name}：缺 frontmatter`); a.skipProofread = true; continue }
      const srcs = readSourceFiles(a.path)
      const missing = srcs.filter((f) => !fs.existsSync(path.join(job.cwd, f)))
      if (missing.length) problems.push(`${a.name}：source_files 缺 ${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' 等' : ''}`)
      a.skipProofread = srcs.length === 0
    }
    if (problems.length) note(job, `本地核对 ${problems.length} 处问题 —— ${problems.slice(0, 4).join('；')}${problems.length > 4 ? '…' : ''}`)
  }

  async function tickReview(job) {
    if (job.batchRef) {
      const results = await settleJob(job)
      if (results === null) return
      tally(job, results, job.tasks, { replace: true })
      job.batchRef = null
      job.tasks = []
      setStage(job, 'index')
      return
    }
    localReview(job)
    const tasks = []
    let i = 0
    for (const a of job.articles) {
      if (!a.ok || !a.path || a.skipProofread) continue
      let articleText = null
      try { articleText = fs.readFileSync(a.path, 'utf8') } catch { continue }
      const articleTokens = estimateTokens(articleText)
      let srcs = collectSources(job.cwd, readSourceFiles(a.path), BATCH_TOKEN_BUDGET - articleTokens)
      if (srcs.oversized) {
        srcs = collectSources(job.cwd, readSourceFiles(a.path), BATCH_TOKEN_HARD_LIMIT - articleTokens)
      }
      if (srcs.oversized) {
        note(job, `${a.name}：首个源文件连大档预算都装不下，跳过校对批次`)
        continue
      }
      tasks.push({
        customId: `proof${i++}`, name: a.name, keepInMemory: true, articlePath: a.path,
        batchPrompt: batchProofreadPrompt({ language: job.language, articleText, sourcesText: srcs.text }),
      })
    }
    if (!tasks.length) { setStage(job, 'index'); return }
    try {
      await submitBatchFor(job, tasks)
      note(job, `校对批次已提交：${tasks.length} 篇`)
    } catch (err) {
      note(job, `校对批次提交失败（跳过校对）—— ${String(err?.message ?? err)}`)
      job.batchRef = null
      job.tasks = []
      setStage(job, 'index')
    }
  }

  async function tickIndex(job) {
    if (job.writtenCount > 0) {
      const binary = resolveBinary(liveConfig(config))
      try {
        const idx = await runCw(binary, job.cwd, ['index'], 120000)
        const meta = await runCw(binary, job.cwd, ['meta', 'update'], 120000)
        note(job, `cw index exit ${idx.exitCode}，cw meta update exit ${meta.exitCode}`)
        if (idx.exitCode !== 0 || meta.exitCode !== 0) note(job, '收尾命令存在失败，编译基线可能未刷新，可重试编译')
        if (idx.exitCode === 0 && normalizeIndexLinks(job.cwd)) note(job, '_index.md 链接路径已规范化（\\ → /）')
      } catch (err) {
        note(job, `cw index/meta 执行异常 —— ${String(err?.message ?? err)}`)
      }
      try {
        if (ensureWikiEntry(job.cwd, job.language)) note(job, '仓库根缺 CodeWiki.md 入口，已自动生成（已有入口不覆盖）')
      } catch (err) {
        note(job, `CodeWiki.md 入口生成失败（忽略）—— ${String(err?.message ?? err)}`)
      }
    } else {
      note(job, '没有文章写成功，跳过 index/meta update（wiki 基线不变，可重新提交）')
    }
    setStage(job, 'done')
    job.finishedAt = new Date().toISOString()
    if (job.writtenCount > 0) onSettled?.(job, 'done') // 实时唤醒发起会话（无 sessionId 时内部静默）
  }

  const STAGE_HANDLER = {
    plan: tickPlan,
    articles: tickArticles,
    crosscut: tickCrosscut,
    compose: tickCompose,
    review: tickReview,
    index: tickIndex,
  }

  async function tick() {
    if (ticking) return
    if (!acquireTickLock()) return // 另一实例正在推进，本轮让路
    ticking = true
    try {
      syncCancelFlags()
      for (const job of jobs) {
        if (JOB_TERMINAL.has(job.stage)) continue
        if (job.owner && job.owner !== instanceId) {
          // 另一实例的 job：它活着会随批次轮询 touch（updatedAt 每 tick 前进）；
          // 停更超时视为孤儿（宿主重启后 instanceId 变了，旧任务无人推进），接管。
          const idleMs = Date.now() - Date.parse(job.updatedAt || job.createdAt || new Date().toISOString())
          if (Number.isFinite(idleMs) && idleMs <= ORPHAN_TAKEOVER_MS) continue
          note(job, `原实例 ${job.owner} 停更 ${Math.round(idleMs / 60000)} 分钟，本实例接管推进`)
          job.owner = instanceId
          touch(job)
        }
        if (job.stage === 'submitting') continue // 占位：submit 正在 await 凭证，阶段未定
        if (job.cancelRequested) {
          setStage(job, 'cancelled')
          job.finishedAt = new Date().toISOString()
          // 无服务端批次可保留：中断在飞请求（未完成请求不计费），丢弃未收割结果
          const ac = batchAborters.get(job.id)
          if (ac) ac.abort()
          batchResults.delete(job.id)
          if (job.batchRef) note(job, '已取消：在途请求已中断（未完成请求不计费）')
          touch(job)
          continue
        }
        const handler = STAGE_HANDLER[job.stage]
        if (!handler) { fail(job, `未知阶段 ${job.stage}`); continue }
        try {
          await handler(job)
        } catch (err) {
          fail(job, `阶段 ${job.stage} 异常 —— ${String(err?.message ?? err)}`)
        }
        if (JOB_TERMINAL.has(job.stage)) persist()
      }
      flush()
    } finally {
      releaseTickLock()
      ticking = false
    }
  }

  async function submit({ kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId }) {
    const c0 = liveConfig(config)
    const exHit = excludedItem(cwd, c0.excludePaths)
    if (exHit) {
      throw new Error(`该目录在 CodeWiki 排除清单中，不编译：${cwd}（命中排除项：${exHit}；在插件设置或面板「设置」页编辑排除清单）`)
    }
    rememberRepo(cwd)
    const existing = jobs.find((j) => j.cwd === cwd && !JOB_TERMINAL.has(j.stage))
    if (existing) return { job: existing, existed: true }
    // 占位先行：resolveBatchApiKey 最长等 3s，期间的并发提交靠非终态 stage 挡重复
    const job = {
      id: `job-${Date.now().toString(36)}-${(seq++).toString(36)}`,
      cwd, wikiPath, scope, language, kind,
      owner: instanceId,
      stage: 'submitting',
      auto: auto === true,
      sessionId: sessionId ?? null, // 发起会话：编译终态 steer 唤醒（面板/自动调度为 null，不唤醒）
      plan: null,
      batchRef: null,
      tasks: [],
      articles: [],
      writtenCount: 0,
      failedCount: 0,
      usage: { inputTok: 0, outputTok: 0, requests: 0, batchRequests: 0, realtimeRequests: 0, overTier2: 0 },
      stageTimings: {},
      stageStartedAt: new Date().toISOString(),
      notes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    jobs.push(job)
    persist()
    let k
    try {
      k = await resolveBatchApiKey(hostCtxRef, liveConfig(config))
      if (!k) throw new Error('未找到百炼 API Key——在模型设置确认「阿里百炼云」渠道凭证，或在插件设置填 batchApiKey（编译流水线没有子代理回退）')
    } catch (err) {
      fail(job, String(err?.message ?? err))
      flush()
      throw err
    }
    job.credentialSource = k.source
    job.apiKey = k.key
    setStage(job, kind === 'full' ? 'plan' : 'articles')
    if (kind === 'stale') job.tasks = prebuiltTasks ?? []
    persist()
    flush() // 先落盘再推进：tick 中途崩溃也能从文件恢复
    void tick() // 立即推进一步，不等首个 tick 间隔
    return { job, existed: false }
  }

  function cancel(jobId) {
    mergeFromDisk() // 另一实例提交的 job 可能还没被本实例吸收过
    const job = jobs.find((j) => j.id === jobId)
    if (!job || JOB_TERMINAL.has(job.stage)) return false
    job.cancelRequested = true
    note(job, '收到取消请求，将在本轮收尾')
    touch(job)
    flush()
    return true
  }

  const list = () => { mergeFromDisk(); return jobs.map(jobSummary) }
  const findActive = (cwd) => jobs.find((j) => j.cwd === cwd && !JOB_TERMINAL.has(j.stage)) ?? null

  function start() {
    if (timer) return
    timer = setInterval(() => { void tick() }, TICK_MS)
    timer.unref?.()
  }
  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { submit, cancel, list, findActive, start, stop }
}


// ---------------------------------------------------------------------------
// 工具 2：codewiki_generate（提交制——判态与提交，编译由服务推进）
// ---------------------------------------------------------------------------

function generateToolDefinition(cfg, svc) {
  return {
    name: 'codewiki_generate',
    description: [
      '编译/刷新指定仓库的 CodeWiki（服务化全批量流水线，零子代理）。调用即提交：cw status 判态 → 提交后台编译任务（job）立即返回；宿主服务以 10s 节拍推进阶段机（规划→模块文章→横切→校对→索引），全部模型环节走阿里云百炼普通入口（chat/completions，输入按 ≤32k token 低价档分块装填）。',
      'scope=auto（默认）：无 wiki 或未编译走全量；有变更走逐篇更新；最新则直接报告。scope=full：强制全量重编。scope=stale：只刷新过期文章。',
      '进度：调用即提交后请继续手头工作，不要等待或反复轮询；需要进度时用 codewiki_progress 工具（只读、立即返回），或在侧边栏 CodeWiki 面板 / GET /api/codewiki/jobs（回环地址）查看；POST /api/codewiki/control {action:"cancel",jobId} 取消。宿主重启后活动任务自动恢复推进（进行中的请求按 prompt 快照自动重跑当前阶段）。',
      '凭证自动取模型设置「阿里百炼云」渠道（或插件设置 batchApiKey），取不到时报错而不是降级子代理。全量编译小仓库也要几分钟（多请求排队+生成），适合后台调用。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '仓库绝对路径（git 仓库；Windows 支持 C:/... 与 Git-Bash /c/... 形式）' },
        scope: { type: 'string', enum: ['auto', 'full', 'stale'], description: '编译范围，默认 auto' },
        language: { type: 'string', description: '文章语言，默认取插件设置（中文）' },
      },
      required: ['cwd'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          scope: { type: 'string' },
          wikiPath: { type: 'string' },
          state: { type: 'string' },
          jobId: { type: 'string' },
          stage: { type: 'string' },
          submitted: { type: 'boolean' },
          notes: { type: 'array', items: { type: 'string' } },
        },
        required: ['cwd', 'scope', 'wikiPath', 'state', 'submitted', 'notes'],
      },
      render(args, value) {
        const lines = [`codewiki_generate（${value.scope}，${value.cwd}）`]
        if (value.wikiPath) lines.push(`wiki：${value.wikiPath}`)
        if (value.submitted) lines.push(`已提交后台任务 ${value.jobId}（stage ${value.stage}）——服务 10s 节拍推进，侧边栏 CodeWiki 面板或 GET /api/codewiki/jobs 查进度`)
        else lines.push(`未提交任务（state ${value.state}）`)
        for (const n of value.notes) lines.push(`· ${n}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args, exec) => {
      const c = liveConfig(cfg)
      if (!c.enabled) throw new Error('codewiki_generate：插件已在设置中停用（codewiki → enabled）')
      if (!svc) throw new Error('codewiki_generate：编排服务未初始化')
      const cwd = normalizeCwd(args.cwd)
      if (!cwd || !fs.existsSync(cwd)) throw new Error(`codewiki_generate：cwd 不存在：${args.cwd ?? ''}`)
      const exHit = excludedItem(cwd, c.excludePaths)
      if (exHit) throw new Error(`该目录在 CodeWiki 排除清单中，不编译：${cwd}（命中排除项：${exHit}；在插件设置或面板「设置」页编辑排除清单）`)
      const scope = ['auto', 'full', 'stale'].includes(args.scope) ? args.scope : 'auto'
      const auto = args.auto === true // 内部直调（自动调度/面板编译）打的标，工具 schema 不暴露
      const language = String(args.language ?? '').trim() || c.articleLanguage
      const notes = []
      const sessionId = exec?.agent?.id ?? null // 发起会话：编译终态时 steer 唤醒（面板/自动调度无 agent 上下文=不唤醒）

      const binary = resolveBinary(c)
      const statusRes = await runCw(binary, cwd, ['status'], 120000, exec?.signal)
      if (statusRes.timedOut) throw new Error('codewiki_generate：cw status 超时')
      if (statusRes.exitCode !== 0 && !(statusRes.stdout ?? '').trim()) {
        throw new Error(`codewiki_generate：cw status 失败（exit ${statusRes.exitCode}）—— ${(statusRes.stderr || statusRes.stdout || '').trim()}`)
      }
      const status = parseStatus(statusRes.stdout)
      const wikiPath = await wikiPathFor(cwd, binary, exec?.signal)
      // jobId/stage 仅在提交/幂等/续查路径赋值——不放 null 占位（宿主按 output schema 校验，null 不是 string）
      const result = { cwd, scope, wikiPath, state: status.state, submitted: false, notes }

      // 幂等：同仓库已有活动任务直接返回
      const active = svc.findActive(cwd)
      if (active) {
        if (sessionId) active.sessionId = sessionId // 最近一次关心该仓库的会话拿唤醒权
        notes.push(`该仓库已有进行中的编译任务 ${active.id}（stage ${active.stage}），本次调用直接返回现有任务`)
        result.jobId = active.id
        result.stage = active.stage
        result.scope = active.scope
        return result
      }

      // scope 修正：stale 遇到没有 wiki 的仓库自动升全量
      let effectiveScope = scope
      if (scope === 'stale' && (status.state === 'missing' || status.state === 'uncompiled')) {
        effectiveScope = 'full'
        notes.push('scope=stale 但尚无 wiki，自动升为全量编译')
      }
      const needsFullCompile = effectiveScope === 'full' || status.state === 'missing' || status.state === 'uncompiled'

      // clean：直接报告（scope=full 例外：强制全量重编）
      if (status.state === 'clean' && effectiveScope !== 'full') {
        notes.push('Wiki is up to date —— 无需编译')
        return result
      }

      // stale / auto 逐篇更新：任务在提交时预构建（服务直接进 articles 阶段）
      if (!needsFullCompile && status.state === 'stale' && status.staleArticles.length) {
        const tasks = status.staleArticles.map((articleRel) => {
          const articlePath = path.join(wikiPath, articleRel.replace(/\\/g, '/'))
          const sourceFiles = readSourceFiles(articlePath)
          if (!sourceFiles.length) {
            notes.push(`文章 ${articleRel} 无 source_files frontmatter，跳过（可手工处理或用 scope=full）`)
            return null
          }
          return {
            name: articleRel,
            mission: `更新过期文章 ${articleRel}：以当前代码为准重写其内容，保留章节结构与 title/type/tags`,
            sources: sourceFiles,
            cwd,
            articlePath,
            prevArticlePath: articlePath,
          }
        }).filter(Boolean)
        if (tasks.length) {
          const { job } = await svc.submit({ kind: 'stale', cwd, wikiPath, scope: effectiveScope, language, prebuiltTasks: tasks, auto, sessionId })
          notes.push(`已提交 ${tasks.length} 篇过期文章更新任务 ${job.id}`)
          result.jobId = job.id
          result.stage = job.stage
          result.submitted = true
          return result
        }
        notes.push('没有可更新的过期文章，改走全量编译')
      }

      // stale 但解析不出过期文章
      if (!needsFullCompile && status.state === 'stale' && !status.staleArticles.length) {
        if (status.changedFiles.length) {
          const meta = await runCw(binary, cwd, ['meta', 'update'], 120000, exec?.signal)
          notes.push(`有 ${status.changedFiles.length} 个文件变更但未命中任何文章的 source_files，已刷新编译基线（meta update exit ${meta.exitCode}）`)
          return result
        }
        notes.push('cw status 输出无法解析，改走全量编译')
      }

      // 全量编译（scope=full，或 auto 命中 missing/uncompiled/无法解析）
      if (status.state === 'missing') {
        const init = await runCw(binary, cwd, ['init'], 120000, exec?.signal)
        if (init.exitCode !== 0) {
          throw new Error(`codewiki_generate：cw init 失败（exit ${init.exitCode}）—— ${(init.stderr || init.stdout || '').trim()}`)
        }
        notes.push('cw init 完成')
      }

      const { job } = await svc.submit({ kind: 'full', cwd, wikiPath, scope: effectiveScope, language, auto, sessionId })
      notes.push(`已提交全量编译任务 ${job.id}（规划→模块文章→横切→校对→索引，全部走百炼普通入口）`)
      result.jobId = job.id
      result.stage = job.stage
      result.submitted = true
      return result
    },
  }
}

// ---------------------------------------------------------------------------
// 工具 2b：codewiki_update（日常维护入口：提交更新请求即返回，完成后提醒提交改动）
// 与 codewiki_generate 的差别只在语义与引导文案：固定 scope=auto，返回值明确告诉
// 模型「继续下一项、不要等待」；编译完成后由系统提示的提交提醒（commitHintText）
// 把「该提交 .codewiki 改动了」送回主模型——插件不代跑 git，提交动作留给模型。
// ---------------------------------------------------------------------------

function updateToolDefinition(cfg, generateDef) {
  return {
    name: 'codewiki_update',
    description: [
      '提交 CodeWiki 更新请求（日常维护入口，scope=auto 语义）：无 wiki 走全量编译，有变更走逐篇更新，已是最新则直接报告。调用即提交、立即返回——请继续下一项工作，不要等待或反复轮询（进度可用 codewiki_progress 查询）。',
      '更新完成后你会收到实时唤醒消息「CodeWiki 编译完成·请提交改动」（编译结束即刻 steer 送达本会话，无需轮询；系统提示 section 亦有同款提醒兜底）：届时检查并提交 .codewiki/ 与 CodeWiki.md 的改动（插件不代跑 git）。与 codewiki_generate 的关系：本工具是固定 scope=auto 的快捷入口，需要 scope=full/stale 时仍用 codewiki_generate。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '仓库绝对路径（git 仓库；Windows 支持 C:/... 与 Git-Bash /c/... 形式）' },
        language: { type: 'string', description: '文章语言，默认取插件设置（中文）' },
      },
      required: ['cwd'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          scope: { type: 'string' },
          wikiPath: { type: 'string' },
          state: { type: 'string' },
          jobId: { type: 'string' },
          stage: { type: 'string' },
          submitted: { type: 'boolean' },
          notes: { type: 'array', items: { type: 'string' } },
        },
        required: ['cwd', 'scope', 'wikiPath', 'state', 'submitted', 'notes'],
      },
      render(args, value) {
        const lines = [`codewiki_update（${value.cwd}）`]
        if (value.wikiPath) lines.push(`wiki：${value.wikiPath}`)
        if (value.submitted) lines.push(`更新已开始（任务 ${value.jobId}，stage ${value.stage}）——已提交后台编译，请继续下一项工作，不要等待；完成后系统提示会出现「请提交改动」提醒`)
        else lines.push(`无需更新（state ${value.state}）——wiki 已是最新，继续手头工作即可`)
        for (const n of value.notes) lines.push(`· ${n}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args, exec) => {
      try {
        const result = await generateDef.execute({ ...args, scope: 'auto' }, exec)
        if (result.submitted === true) {
          result.notes.push('更新已在后台进行：继续下一项工作，不要等待；更新完成后系统提示会出现「CodeWiki 编译完成·请提交改动」提醒，按提醒提交 .codewiki/ 与 CodeWiki.md')
        }
        return result
      } catch (err) {
        throw new Error(String(err?.message ?? err).replaceAll('codewiki_generate', 'codewiki_update'))
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 工具 3：codewiki_progress（只读查进度——提交后轮询，不阻塞、不等待）
// 提交制下模型最常见的误用是「提交后空等/反复问编译好没有」；本工具把 jobSummary
// （与侧边栏面板同源）直接暴露成只读查询，一行看出 stage/百分比/篇数/失败原因。
// ---------------------------------------------------------------------------

function samePath(a, b) {
  const norm = (p) => path.normalize(String(p ?? '')).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function progressView(job) {
  const taskList = job.taskList ?? []
  const done = taskList.filter((t) => t.state === 'done').length
  return { ...job, progress: taskList.length ? Math.round((done / taskList.length) * 100) : null }
}

function progressToolDefinition(cfg, svc) {
  return {
    name: 'codewiki_progress',
    description: [
      '查询 CodeWiki 编译任务进度（只读，立即返回，不等待编译完成）。',
      'codewiki_generate 是提交制：调用即返回，编译由宿主后台服务推进——提交后直接继续手头工作，需要进度时再调用本工具（数据与侧边栏 CodeWiki 面板同源）。',
      '可选按 cwd（仓库路径）或 jobId 过滤；都不传则列出全部任务。输出含 stage（plan/articles/crosscut/compose/review/index/done/failed/cancelled）、完成百分比、已写/失败篇数、任务明细、批量进度、阶段耗时、token 用量、notes 与错误。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '可选：只查该仓库（git 仓库根或子目录）的任务；省略则列出全部任务' },
        jobId: { type: 'string', description: '可选：只查指定任务 id（codewiki_generate 返回值里的 jobId）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          jobs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                cwd: { type: 'string' },
                kind: { type: 'string' },
                scope: { type: 'string' },
                stage: { type: 'string' },
                progress: { type: 'number' },
                writtenCount: { type: 'number' },
                failedCount: { type: 'number' },
                cancelRequested: { type: 'boolean' },
                taskList: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, state: { type: 'string' } } } },
                batchProgress: { oneOf: [{ type: 'object' }, { type: 'null' }] },
                stageTimings: { type: 'object' },
                usage: { type: 'object' },
                tps: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                notes: { type: 'array', items: { type: 'string' } },
                error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
                finishedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
            },
          },
        },
        required: ['jobs'],
      },
      render(args, value) {
        if (!value.jobs.length) return [{ type: 'text', text: 'codewiki_progress：没有匹配的编译任务' }]
        const lines = [`codewiki_progress：${value.jobs.length} 个任务`]
        for (const j of value.jobs) {
          const pct = j.progress === null ? '' : ` ${j.progress}%`
          const head = `${j.id} ${j.cwd}｜${j.kind}/${j.scope}｜stage=${j.stage}${pct}｜写 ${j.writtenCount} 篇/失败 ${j.failedCount}${j.cancelRequested ? '｜取消中' : ''}`
          lines.push(head)
          for (const t of (j.taskList ?? [])) {
            const mark = t.state === 'done' ? '✓' : t.state === 'failed' ? '✗' : '·'
            lines.push(`  ${mark} ${t.name}`)
          }
          if (j.error) lines.push(`  错误：${j.error}`)
          for (const n of (j.notes ?? []).slice(-3)) lines.push(`  · ${n}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const c = liveConfig(cfg)
      if (!c.enabled) throw new Error('codewiki_progress：插件已在设置中停用（codewiki → enabled）')
      if (!svc) throw new Error('codewiki_progress：编排服务未初始化')
      let list = svc.list()
      const jobId = String(args.jobId ?? '').trim()
      if (jobId) {
        list = list.filter((j) => j.id === jobId)
      } else {
        const cwd = normalizeCwd(args.cwd)
        if (cwd) list = list.filter((j) => samePath(j.cwd, cwd))
      }
      return { jobs: list.map(progressView) }
    },
  }
}

// ---------------------------------------------------------------------------
// 本机面板后端：GET /api/codewiki/jobs、POST /api/codewiki/control（仅回环）
// ---------------------------------------------------------------------------

function isLoopbackRequest(req) {
  const addr = String(req?.socket?.remoteAddress ?? '')
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function writeJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体超过 1MB'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function installWebServer(ctx, service, extra = {}) {
  const { config, schedState, compile } = extra
  if (typeof ctx.inject !== 'function') return
  // 宿主工作区注册表（WorkspaceRegistry.list() 同步内存投影）：任务页过滤数据源。
  // 服务缺失（老宿主/测试 ctx）时保持 null——jobs 端点不过滤，行为与 0.4.8 一致。
  let workspaceRegistry = null
  // cordis inject 回调参数是「注入了所声明服务的 ctx 切片」，服务本体在切片同名属性上
  // （0.4.10 真宿主 `cannot get property "list" without inject` 的根因：切片被当成实例存下）。
  // 兼容旧 mock 直传实例的形态：切片无同名属性时回退参数本身，且必须带 list 方法。
  ctx.inject(['workspaceRegistry'], (rc) => {
    const wr = rc?.workspaceRegistry ?? rc
    workspaceRegistry = wr && typeof wr.list === 'function' ? wr : null
  })
  // 工作区过滤清单（jobs 与 repos 总览共用）：宿主注册表可用且开关开启时返回路径清单，否则 null。
  // cwd 等于某工作区或位于其子目录内（isExcluded 命中判定，语义同 hindsight withinPath）；
  // 宿主未注册任何工作区时返回 null——不过滤，行为与 0.4.8 一致。
  const wsFilterPaths = () => {
    const wr = workspaceRegistry
    if (!wr || typeof wr.list !== 'function') return null
    if (liveConfig(config ?? {}).workspaceOnly === false) return null
    let wsList
    try {
      wsList = wr.list() ?? []
    } catch (err) {
      // 宿主注册表内部不一致（如 order references missing workspace）时降级不过滤：
      // 过滤是体验优化，不能拖垮 jobs/repos 端点。
      console.warn('[codewiki] workspaceRegistry.list() 抛错，工作区过滤降级停用：', err?.message ?? err)
      return null
    }
    const wsPaths = wsList.map((w) => w?.path).filter((p) => typeof p === 'string' && p)
    return wsPaths.length ? wsPaths : null
  }
  // cordis：webServer 服务缺失时 inject 回调整体跳过（静默降级，面板查不到进度但不报错）
  ctx.inject(['webServer'], (rc) => {
    const ws = rc?.webServer ?? rc
    if (!ws || typeof ws.register !== 'function') return
    const guard = (req, res) => {
      if (isLoopbackRequest(req)) return true
      writeJson(res, 403, { error: 'loopback only' })
      return false
    }
    ws.register({
      kind: 'exact',
      path: '/api/codewiki/jobs',
      handler: (req, res) => {
        if (!guard(req, res)) return
        try {
          let list = service.list()
          // workspaceOnly（默认开）：Temp 沙箱与任意路径任务不出现在面板。
          const wsPaths = wsFilterPaths()
          if (wsPaths) list = list.filter((j) => isExcluded(j.cwd, wsPaths))
          writeJson(res, 200, { now: new Date().toISOString(), jobs: list })
        } catch (err) {
          // 宿主 webserver 对 handler reject 只回 400 空 body——把错误栈直接写进响应体便于排查
          writeJson(res, 500, { error: String(err?.message ?? err), stack: String(err?.stack ?? '').split('\n').slice(0, 8) })
        }
      },
    })
    // 仓库总览：jobs 历史工作区的 wiki 状态（cw status 现算，30s 缓存——面板 2s 轮询不打爆 git）
    let reposCache = null
    let reposCacheAt = 0
    ws.register({
      kind: 'exact',
      path: '/api/codewiki/repos',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
        const wsSig = (() => { const p = wsFilterPaths(); return p ? [...p].sort().join('|') : '' })()
        if (!reposCache || reposCache.sig !== wsSig || Date.now() - reposCacheAt > 30000) {
          const c = liveConfig(config ?? {})
          const normKey = (p) => path.normalize(String(p ?? '')).replace(/[\\/]+$/, '').toLowerCase()
          const seen = new Map() // normKey → 展示用 cwd（job 历史形态优先，knownRepos 补缺）
          const lastByCwd = new Map()
          const putCwd = (dir, last) => {
            if (!dir) return
            const k = normKey(dir)
            if (seen.has(k)) {
              if (last && !lastByCwd.get(seen.get(k))) lastByCwd.set(seen.get(k), last)
              return
            }
            seen.set(k, dir)
            lastByCwd.set(dir, last ?? null)
          }
          // workspaceOnly（默认开）：总览只显示已添加工作区（含其子仓库）——knownRepos/job
          // 历史里的 Temp 沙箱与任意路径目录不再出现；无清单时不过滤。
          const wsPaths = wsFilterPaths()
          const inWs = (dir) => !wsPaths || isExcluded(dir, wsPaths)
          for (const j of service.list()) if (inWs(j.cwd)) putCwd(j.cwd, j)
          for (const dir of loadKnownRepos()) if (inWs(dir)) putCwd(dir, null)
          const repos = []
          for (const cwd of seen.values()) {
            const last = lastByCwd.get(cwd)
            const base = {
              cwd,
              excluded: isExcluded(cwd, c.excludePaths),
              lastJob: last ? {
                id: last.id, kind: last.kind, stage: last.stage, auto: last.auto === true,
                finishedAt: last.finishedAt ?? null, writtenCount: last.writtenCount ?? 0,
                tps: last.tps ?? null, batchProgress: last.batchProgress ?? null,
                batchSubmittedAt: last.batchSubmittedAt ?? null,
                taskList: JOB_TERMINAL.has(last.stage) ? [] : (last.taskList ?? []),
              } : null,
            }
            try {
              const binary = resolveBinary(c)
              const st = await runCw(binary, cwd, ['status'], 20000)
              const status = parseStatus(st.stdout)
              const wp = await wikiPathFor(cwd, binary).catch(() => null)
              repos.push({
                ...base,
                state: status.state,
                staleArticles: status.staleArticles.length,
                changedFiles: status.changedFiles.length,
                wikiPath: wp,
                articleCount: wp ? countWikiArticles(wp) : null,
              })
            } catch (err) {
              repos.push({ ...base, state: 'error', error: String(err?.message ?? err) })
            }
          }
          reposCache = {
            sig: wsSig,
            repos,
            scheduler: {
              enabled: c.autoUpdate,
              intervalMin: c.autoUpdateMin,
              lastScan: schedState?.lastScan ? new Date(schedState.lastScan).toISOString() : null,
              scanning: schedState?.scanning === true,
              lastError: schedState?.lastError ?? null,
              lastScanRepos: schedState?.lastScanRepos ?? null,
              lastScanSubmitted: schedState?.lastScanSubmitted ?? null,
            },
          }
          reposCacheAt = Date.now()
        }
        writeJson(res, 200, reposCache)
        } catch (err) {
          writeJson(res, 500, { error: String(err?.message ?? err), stack: String(err?.stack ?? '').split('\n').slice(0, 8) })
        }
      },
    })
    ws.register({
      kind: 'exact',
      path: '/api/codewiki/control',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
        let body
        try { body = await readBodyJson(req) } catch (err) { writeJson(res, 400, { error: String(err?.message ?? err) }); return }
        if (body?.action === 'cancel' && body?.jobId) {
          const ok = service.cancel(String(body.jobId))
          writeJson(res, ok ? 200 : 404, { ok })
          return
        }
        if (body?.action === 'refresh') {
          reposCache = null
          writeJson(res, 200, { ok: true })
          return
        }
        if (body?.action === 'compile' && body?.cwd) {
          if (typeof compile !== 'function') { writeJson(res, 501, { error: '编译入口未初始化' }); return }
          reposCache = null // 编译提交会改 wiki 状态，下次拉总览强制重算
          try {
            const r = await compile({ cwd: String(body.cwd), scope: ['auto', 'full', 'stale'].includes(body?.scope) ? body.scope : 'auto' }, {})
            writeJson(res, 200, { ok: true, ...r })
          } catch (err) {
            writeJson(res, 400, { ok: false, error: String(err?.message ?? err) })
          }
          return
        }
        writeJson(res, 400, { error: '未知 action；支持 {"action":"cancel","jobId":"..."} / {"action":"compile","cwd":"..."} / {"action":"refresh"}' })
      },
    })
  })
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

// 会话系统提示里的 wiki 维护提醒：只在会话仓库根存在 wiki 入口 CodeWiki.md 时出现。
// 判定不看 .codewiki/ 目录——半途建出的空骨架（只有空子目录）会骗过目录存在性检查，
// 提醒却指向一个读不到的入口。无 CodeWiki.md = 无可维护的 wiki。text 回调每次组装时
// 求值——cwd、入口文件存在性、开关全部实时读取，关闭开关/项目切换/删掉 wiki 都无需重启。
// 编译完成后的提交提醒：最近一次成功编译（stage=done 且有文章写成功）的完成时间晚于
// .codewiki/（与 CodeWiki.md）最后一次 git 提交时间 → 该次编译产物尚未入库，系统提示
// 注入「请提交改动」。零状态派生（jobs 文件 + git log 时间戳），提交后时间戳反超自动静默；
// 非 git 仓库/读 jobs 失败一律不提醒。60s TTL 缓存：text 回调每次组装系统提示都求值。
const commitHintCache = new Map() // cwd -> { at, text }
export function commitHintText(cwd, jobs = loadJobs()) {
  const key = path.normalize(String(cwd ?? ''))
  const hit = commitHintCache.get(key)
  if (hit && Date.now() - hit.at < 60000) return hit.text
  let text = ''
  try {
    const latest = jobs
      .filter((j) => j.stage === 'done' && (j.writtenCount ?? 0) > 0 && j.finishedAt && samePath(j.cwd, cwd))
      .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0]
    if (latest) {
      const g = spawnSync('git', ['-C', cwd, 'log', '-1', '--format=%ct', '--', '.codewiki', 'CodeWiki.md'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      const commitSec = Number.parseInt(String(g.stdout ?? '').trim(), 10)
      const jobSec = Math.floor(Date.parse(latest.finishedAt) / 1000)
      if (Number.isFinite(jobSec) && (!Number.isFinite(commitSec) || jobSec > commitSec)) {
        const mins = Math.max(1, Math.round((Date.now() - Date.parse(latest.finishedAt)) / 60000))
        text = [
          `【CodeWiki 编译完成·请提交改动】本仓库 wiki 编译已完成（${mins} 分钟前，任务 ${latest.id}，写入 ${latest.writtenCount} 篇文章），编译产物尚未提交 git：`,
          '- 检查 .codewiki/ 与 CodeWiki.md 的未提交改动并提交（只 add 这两个路径，建议 docs(wiki) 前缀；不要 git add -A）；与当前任务代码改动同轮收尾时可一起提交；',
          '- 若这些产物已入库或判断无需提交，忽略本提醒（提交后提醒自动消失）。',
        ].join('\n')
      }
    }
  } catch { /* 非 git 仓库 / jobs 读取失败 → 不提醒 */ }
  commitHintCache.set(key, { at: Date.now(), text })
  return text
}

function reminderText(cwd) {
  return [
    '【CodeWiki 维护】本仓库存在 wiki（入口 CodeWiki.md），涉及代码改动的任务收尾时必须：',
    '- 调用 codewiki_generate 工具（scope=auto 即可）更新受影响文章——learnings/、decisions/ 补文章与索引刷新均由流水线完成；不要手工编写或修改 .codewiki/ 下的文章（手改不进流水线、不被面板记录，还会被下次编译覆盖）；',
    '- codewiki_generate 是后台编译：调用即返回，编译由宿主服务推进——不要等待编译完成，提交后继续其他工作，需要进度时用 codewiki_progress 工具查询；',
    `- wiki 入口 CodeWiki.md 与 .codewiki/ 全部内容都在仓库根 ${cwd}，在本目录之外读写它们时一律用绝对路径；`,
    '- .codewiki/ 的改动与本次代码改动一起提交；',
    '- 收尾未调用 codewiki_generate 视为任务未完成。',
  ].join('\n')
}

function installUpdateReminder(ctx, config) {
  if (typeof ctx.on !== 'function') return
  const seen = new WeakSet()
  const install = (agent) => {
    if (!agent || seen.has(agent)) return
    seen.add(agent)
    agent.ctx?.inject?.(['systemPrompt'], (rc2) => {
      const sp = rc2?.systemPrompt ?? rc2
      if (typeof sp?.section !== 'function') return
      sp.section({
        name: 'codewiki:update-reminder',
        order: (typeof sp.getSectionOrder === 'function' ? sp.getSectionOrder('TOOL_REPORT') : 2900) + 1,
        text: () => {
          if (val(config?.updateReminder) === false) return ''
          const cwd = String(agent.session?.header?.cwd ?? '')
          if (!cwd || !fs.existsSync(path.join(cwd, 'CodeWiki.md'))) return ''
          const hint = commitHintText(cwd)
          return hint ? `${reminderText(cwd)}\n\n${hint}` : reminderText(cwd)
        },
      })
    })
  }
  // cordis：插件 ctx 上未声明 inject 的服务属性，访问本身即抛（typeof 守卫无效）；
  // 存量代理改经 inject(['agents']) 获取，服务缺失时静默跳过，新会话仍走 agent/created。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents'], (rc3) => {
      const agents = rc3?.agents ?? rc3
      if (typeof agents?.list !== 'function') return
      for (const agent of agents.list()) install(agent)
    })
  }
  ctx.on('agent/created', async ({ agent } = {}) => { install(agent) })
}

export function apply(ctx, config) {
  hostCtxRef = ctx
  if (typeof ctx.inject === 'function') ctx.inject(['agents'], (rc) => { agentsRef = rc?.agents ?? rc })
  if (typeof ctx.inject === 'function') ctx.inject(['llm'], (rc) => { llmRef = rc?.llm ?? rc })
  const service = createJobService(config, wakeCompileSession)
  service.start()
  // cordis effect：立即执行 body 并把返回值收集为 disposer——必须返回清理函数本身，
  // 写成 () => service.stop() 会在启动时当场停掉服务（返回 undefined 也无 disposer）
  if (typeof ctx.effect === 'function') ctx.effect(() => () => service.stop())
  const generateDef = generateToolDefinition(config, service)
  const updateDef = updateToolDefinition(config, generateDef)
  // 自动更新调度器：60s 心跳，到点对历史工作区逐个 scope=auto 判态提交。
  // execute 幂等（活动仓库直接返回现有任务），单仓库失败只记 lastError 不打断扫描。
  const schedState = { lastScan: 0, scanning: false, lastError: null, lastScanRepos: null, lastScanSubmitted: null }
  let scanning = false
  const autoScan = async () => {
    const c = liveConfig(config)
    if (!c.autoUpdate || scanning) return
    if (Date.now() - schedState.lastScan < c.autoUpdateMin * 60000) return
    scanning = true
    schedState.scanning = true
    schedState.lastScan = Date.now()
    schedState.lastScanRepos = 0
    schedState.lastScanSubmitted = 0
    try {
      const cwds = [...new Set(service.list().map((j) => j.cwd).filter(Boolean))]
      for (const cwd of cwds) {
        if (isExcluded(cwd, c.excludePaths)) continue
        schedState.lastScanRepos++
        try {
          const r = await generateDef.execute({ cwd, scope: 'auto', auto: true }, {})
          if (r?.submitted === true) schedState.lastScanSubmitted++
        } catch (err) {
          schedState.lastError = `${new Date().toISOString()} ${String(err?.message ?? err).slice(0, 200)}`
        }
      }
    } finally { scanning = false; schedState.scanning = false }
  }
  const scanTimer = setInterval(() => { void autoScan() }, 60000)
  scanTimer.unref?.()
  if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(scanTimer))
  ctx.inject?.(['tools'], (rc) => {
    const tools = rc?.tools ?? rc
    if (!tools?.register) return
    for (const definition of [cwToolDefinition(config), generateDef, updateDef, progressToolDefinition(config, service)]) {
      // 单工具 schema 违规只丢该工具：宿主 register 校验（assertSupportedJsonSchema）抛错时
      // 不能让它炸掉回调——cordis 会把 apply 回调失败视为 fiber FAILED 并回滚已注册的全部工具
      try {
        const disposer = tools.register(definition)
        if (typeof disposer === 'function') {
          if (typeof ctx.effect === 'function') ctx.effect(() => disposer)
          else ctx.on?.('dispose', () => { try { disposer() } catch { /* 忽略 */ } })
        }
      } catch (err) {
        console.error(`[codewiki] 工具 ${definition.name} 注册失败（该工具不可用）：`, err?.message ?? err)
      }
    }
  })
  installWebServer(ctx, service, { config, schedState, compile: (args, exec) => generateDef.execute(args, exec) })
  installUpdateReminder(ctx, config)
}
